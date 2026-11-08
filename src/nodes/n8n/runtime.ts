import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateN8nExpression } from '../../expressions/n8n-expression.ts';
import type { GraphNodeContext, NodeAdapter, NodeExecutionData } from '../../execution/graph-engine.ts';
import { NodeAdapterRegistry } from '../../execution/graph-engine.ts';
import { N8nPackageCatalog, type CatalogCredential, type CatalogNode } from './package-catalog.ts';

interface NodeTypeLike {
	description?: Record<string, unknown>;
	execute?: (this: GraphNodeContext) => Promise<unknown> | unknown;
	trigger?: (this: GraphNodeContext) => Promise<unknown> | unknown;
	poll?: (this: GraphNodeContext) => Promise<unknown> | unknown;
	webhook?: (this: GraphNodeContext) => Promise<unknown> | unknown;
	[key: string]: unknown;
}

interface VersionedTypeLike extends NodeTypeLike {
	currentVersion?: number;
	nodeVersions?: Record<string, NodeTypeLike>;
	getNodeType?: (version?: number) => NodeTypeLike;
}

interface CredentialTypeLike {
	name?: string;
	displayName?: string;
	properties?: unknown[];
	authenticate?: unknown;
	[key: string]: unknown;
}

/**
 * Loads n8n's published JavaScript modules on first use. Node packages stay
 * outside the Squared bundle and are resolved from the configured package
 * directory, which also makes each package's own dependency tree available.
 */
export class N8nNodePackageRuntime {
	readonly catalog: N8nPackageCatalog;
	private readonly packagesDirectory: string;
	private readonly records = new Map<string, CatalogNode>();
	private readonly credentialRecords = new Map<string, CatalogCredential>();
	private readonly loadedCredentials = new Map<string, Promise<Record<string, unknown>>>();
	private readonly loadedNodes = new Map<string, Promise<{
		wrapper: VersionedTypeLike;
		description: Record<string, unknown>;
		versions: number[];
		require: ReturnType<typeof createRequire>;
		runtime: N8nNodePackageRuntime;
	}>>();
	private initialized = false;

	constructor(packagesDirectory: string) {
		this.packagesDirectory = resolve(packagesDirectory);
		this.catalog = new N8nPackageCatalog(this.packagesDirectory);
	}

	async initialize(registry: NodeAdapterRegistry): Promise<{ packages: string[]; nodes: CatalogNode[] }> {
		const snapshot = await this.catalog.discover();
		await this.catalog.loadDescriptions();
		this.records.clear();
		this.credentialRecords.clear();
		for (const node of this.catalog.snapshot().nodes) {
			if (node.enterpriseRestricted || !node.nodeType) continue;
			if (!node.manifestPath.endsWith('.node.js')) continue;
			if (this.records.has(node.nodeType)) continue;
			this.records.set(node.nodeType, node);
			registry.registerLazy(node.nodeType, () => this.loadAdapter(node));
		}
		for (const credential of this.catalog.snapshot().credentials) {
			if (credential.enterpriseRestricted) continue;
			if (!this.credentialRecords.has(credential.credentialType)) this.credentialRecords.set(credential.credentialType, credential);
		}
		this.initialized = true;
		return { packages: snapshot.packages, nodes: this.catalog.snapshot().nodes };
	}

	async loadDescription(nodeType: string): Promise<Record<string, unknown>> {
		this.ensureInitialized();
		const record = this.records.get(nodeType);
		if (!record) throw new Error(`n8n node type is not installed: ${nodeType}`);
		const loaded = await this.loadNodeType(record);
		return loaded.description;
	}

	async loadCredentialDescription(credentialType: string): Promise<Record<string, unknown>> {
		this.ensureInitialized();
		const cached = this.loadedCredentials.get(credentialType);
		if (cached) return cached;
		const record = this.credentialRecords.get(credentialType);
		if (!record) throw new Error(`n8n credential type is not installed: ${credentialType}`);
		const pending = this.importCredentialType(record);
		this.loadedCredentials.set(credentialType, pending);
		try { return await pending; }
		catch (error) { this.loadedCredentials.delete(credentialType); throw error; }
	}

	getSnapshot() { return this.catalog.snapshot(); }

	private ensureInitialized(): void {
		if (!this.initialized) throw new Error('n8n node package runtime has not been initialized');
	}

	private async loadAdapter(record: CatalogNode): Promise<NodeAdapter> {
		const loaded = await this.loadNodeType(record);
		const versions = loaded.versions.filter((version) => {
			try { return typeof selectNodeType(loaded.wrapper, version).execute === 'function'; } catch { return false; }
		});
		if (versions.length === 0) throw new Error(`Node ${record.nodeType} has no execute() implementation supported by Squared`);
		return {
			type: record.nodeType,
			versions,
			async execute(context) {
				const selected = loaded.wrapper.getNodeType
					? loaded.wrapper.getNodeType(context.node.typeVersion)
					: loaded.wrapper;
				if (typeof selected.execute !== 'function') {
					throw new Error(`Node ${record.nodeType}@${context.node.typeVersion ?? 1} does not implement execute()`);
				}
				const accessed = new Set<string>();
				const facade = createExecutionFacade(context, loaded.require, selected.description ?? loaded.description, accessed, loaded.runtime);
				const output = await selected.execute.call(facade);
				const contracts = ['INodeType', 'IExecuteFunctions', 'INodeExecutionData', ...[...accessed].map((method) => `IExecuteFunctions.${method}`)];
				loaded.runtime.catalog.markRuntimeLoaded(record.nodeType, selected.description ?? loaded.description, 'execute', contracts, true, loaded.versions);
				return output as NodeExecutionData[][];
			},
		};
	}

	private async loadNodeType(record: CatalogNode): Promise<{
		wrapper: VersionedTypeLike;
		description: Record<string, unknown>;
		versions: number[];
		require: ReturnType<typeof createRequire>;
		runtime: N8nNodePackageRuntime;
	}> {
		const cached = this.loadedNodes.get(record.nodeType);
		if (cached) return cached;
		const pending = this.importNodeType(record);
		this.loadedNodes.set(record.nodeType, pending);
		try {
			return await pending;
		} catch (error) {
			this.loadedNodes.delete(record.nodeType);
			throw error;
		}
	}

	private async importNodeType(record: CatalogNode): Promise<{
		wrapper: VersionedTypeLike;
		description: Record<string, unknown>;
		versions: number[];
		require: ReturnType<typeof createRequire>;
		runtime: N8nNodePackageRuntime;
	}> {
		const entryPath = resolve(this.packagesDirectory, record.manifestPath);
		const moduleUrl = pathToFileURL(entryPath).href;
		const entryRequire = createRequire(entryPath);
		const namespace = await import(moduleUrl) as Record<string, unknown>;
		const exportName = basename(entryPath).replace(/\.node(?:\.ee)?\.js$/i, '');
		const NodeConstructor = findNodeConstructor(namespace, exportName);
		if (!NodeConstructor) throw new Error(`No INodeType constructor exported by ${record.manifestPath}`);
		const wrapper = new NodeConstructor() as VersionedTypeLike;
		const wrapperDescription = asRecord(wrapper.description) ?? {};
		const versions = getSupportedVersions(wrapper, wrapperDescription);
		const currentVersion = typeof wrapper.currentVersion === 'number' ? wrapper.currentVersion : versions.at(-1) ?? 1;
		const description = asRecord(selectNodeType(wrapper, currentVersion).description) ?? asRecord(wrapper.description);
		if (!description) throw new Error(`Node module ${record.manifestPath} has no runtime description`);
		const executable = versions.some((version) => {
			try { return typeof selectNodeType(wrapper, version).execute === 'function'; } catch { return false; }
		});
		const interfacesUsed = scanRuntimeContracts(await readFile(entryPath, 'utf8').catch(() => ''), executable);
		this.catalog.markRuntimeLoaded(record.nodeType, description, classifyRuntimeExecution(description), interfacesUsed, false, versions);
		return { wrapper, description, versions, require: entryRequire, runtime: this };
	}

	private async importCredentialType(record: CatalogCredential): Promise<Record<string, unknown>> {
		const entryPath = resolve(this.packagesDirectory, record.manifestPath);
		const namespace = await import(pathToFileURL(entryPath).href) as Record<string, unknown>;
		const exportName = basename(entryPath).replace(/\.credentials(?:\.ee)?\.js$/i, '');
		const Constructor = findCredentialConstructor(namespace, exportName);
		if (!Constructor) throw new Error(`No credential type constructor exported by ${record.manifestPath}`);
		const description = new Constructor() as CredentialTypeLike;
		if (!description.name || !Array.isArray(description.properties)) throw new Error(`Credential ${record.credentialType} has an invalid runtime description`);
		const normalized = { ...description } as Record<string, unknown>;
		this.catalog.markCredentialLoaded(description.name, normalized);
		return normalized;
	}
}

function createExecutionFacade(
	context: GraphNodeContext,
	requireFromPackage: ReturnType<typeof createRequire>,
	description: Record<string, unknown>,
	accessed: Set<string>,
	runtime: N8nNodePackageRuntime,
): GraphNodeContext {
	const workflowModule = requireFromPackage('n8n-workflow') as Record<string, unknown>;
	const facade = new Proxy(context, {
		get(target, property, receiver) {
			if (typeof property === 'string') accessed.add(property);
			const value = Reflect.get(target, property, receiver) as unknown;
			if (property === 'getNodeParameter' && typeof value === 'function') {
				return (parameterName: string, itemIndex = 0, fallbackValue?: unknown, options: Record<string, unknown> = {}) => {
					let resolved: unknown;
					try {
						resolved = (value as GraphNodeContext['getNodeParameter'])(parameterName, itemIndex, fallbackValue, { ...options, extractValue: false });
					} catch (error) {
						if (fallbackValue !== undefined) throw error;
						const defaultValue = getNodeParameterDefault(parameterName, context, description, workflowModule);
						if (defaultValue === undefined) throw error;
						resolved = defaultValue;
					}
					if (options.ensureType) resolved = ensureNodeParameterType(resolved, String(options.ensureType));
					if (options.extractValue) return extractNodeParameterValue(resolved, parameterName, context, description, workflowModule, itemIndex);
					return resolved;
				};
			}
			if (property === 'getCredentials' && typeof value === 'function') {
				return async (credentialType: string, itemIndex = 0) => {
					await runtime.loadCredentialDescription(credentialType);
					return (value as (...args: unknown[]) => Promise<Record<string, unknown>>)(credentialType, itemIndex);
				};
			}
			if (property === 'helpers' && value && typeof value === 'object') {
				return new Proxy(value as Record<string, unknown>, {
					get(helperTarget, helperProperty, helperReceiver) {
						if (typeof helperProperty === 'string') accessed.add(`helpers.${helperProperty}`);
						const helper = Reflect.get(helperTarget, helperProperty, helperReceiver);
						if ((helperProperty === 'requestWithAuthentication' || helperProperty === 'httpRequestWithAuthentication') && typeof helper === 'function') {
							return async (credentialType: string, requestOptions: Record<string, unknown>, ...args: unknown[]) => {
								const credentialDescription = await runtime.loadCredentialDescription(credentialType);
								const credentials = await context.getCredentials(credentialType);
								if (!asRecord(credentialDescription.authenticate)) {
									return (helper as (...parameters: unknown[]) => Promise<unknown>).apply(helperReceiver, [credentialType, requestOptions, ...args]);
								}
								const authenticated = applyDeclaredCredentialAuthentication(requestOptions, credentials, credentialDescription);
								return (Reflect.get(helperTarget, 'httpRequest') as (options: Record<string, unknown>) => Promise<unknown>)(authenticated);
							};
						}
						if (helper !== undefined) return helper;
						if (typeof helperProperty !== 'string') return helper;
						return () => { throw new Error(`n8n IExecuteFunctions.helpers.${helperProperty} is not implemented by Squared`); };
					},
				});
			}
			return value;
		},
	});
	return facade;
}

function getNodeParameterDefault(
	parameterName: string,
	context: GraphNodeContext,
	description: Record<string, unknown>,
	workflowModule: Record<string, unknown>,
): unknown {
	const nodeHelpers = asRecord(workflowModule.NodeHelpers);
	const findDisplayedProperty = nodeHelpers?.findDisplayedProperty;
	if (typeof findDisplayedProperty !== 'function') return undefined;
	const properties = Array.isArray(description.properties) ? description.properties : [];
	try {
		const property = asRecord((findDisplayedProperty as (...args: unknown[]) => unknown)(parameterName, properties, context.node.parameters ?? {}, context.node, description));
		return property?.default;
	} catch {
		return undefined;
	}
}

function ensureNodeParameterType(value: unknown, type: string): unknown {
	if (type === 'string') return value === null || value === undefined ? '' : String(value);
	if (type === 'number') {
		const converted = Number(value);
		if (!Number.isFinite(converted)) throw new Error(`Parameter cannot be converted to a number: ${String(value)}`);
		return converted;
	}
	if (type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
	if (type === 'array') return Array.isArray(value) ? value : [value];
	if (type === 'object') {
		if (isRecord(value)) return value;
		throw new Error('Parameter must be an object');
	}
	if (type === 'json') return typeof value === 'string' ? JSON.parse(value) : value;
	return value;
}

function extractNodeParameterValue(
	value: unknown,
	parameterName: string,
	context: GraphNodeContext,
	description: Record<string, unknown>,
	workflowModule: Record<string, unknown>,
	itemIndex: number,
): unknown {
	const nodeHelpers = asRecord(workflowModule.NodeHelpers);
	const findDisplayedProperty = nodeHelpers?.findDisplayedProperty;
	const properties = Array.isArray(description.properties) ? description.properties : [];
	const property = typeof findDisplayedProperty === 'function'
		? (findDisplayedProperty as (...args: unknown[]) => unknown)(parameterName, properties, context.node.parameters ?? {}, context.node, description)
		: undefined;
	const propertyRecord = asRecord(property);
	if (propertyRecord?.type === 'filter' && typeof workflowModule.executeFilter === 'function') {
		const isFilterValue = workflowModule.isFilterValue;
		if (typeof isFilterValue !== 'function' || (isFilterValue as (candidate: unknown) => boolean)(value)) {
			return (workflowModule.executeFilter as (candidate: unknown, options: { itemIndex: number }) => unknown)(value, { itemIndex });
		}
	}
	if (propertyRecord?.type === 'resourceLocator' && isRecord(value) && 'value' in value) return value.value;
	if (propertyRecord?.extractValue && isRecord(value) && typeof value.value === 'string') return value.value;
	return value;
}

function findNodeConstructor(namespace: Record<string, unknown>, exportName: string): (new () => unknown) | undefined {
	const candidates = [namespace[exportName], namespace.default, ...Object.values(namespace)];
	for (const candidate of candidates) {
		if (typeof candidate !== 'function') continue;
		const prototype = (candidate as { prototype?: Record<string, unknown> }).prototype;
		if (prototype && ('execute' in prototype || 'getNodeType' in prototype || 'trigger' in prototype || 'poll' in prototype || 'webhook' in prototype)) {
			return candidate as new () => unknown;
		}
	}
	return undefined;
}

function findCredentialConstructor(namespace: Record<string, unknown>, exportName: string): (new () => CredentialTypeLike) | undefined {
	const candidates = [namespace[exportName], namespace.default, ...Object.values(namespace)];
	for (const candidate of candidates) {
		if (typeof candidate !== 'function') continue;
		try {
			const instance = new (candidate as new () => CredentialTypeLike)();
			if (typeof instance.name === 'string' && Array.isArray(instance.properties)) return candidate as new () => CredentialTypeLike;
		} catch { /* continue looking through generated CommonJS exports */ }
	}
	return undefined;
}

function applyDeclaredCredentialAuthentication(
	requestOptions: Record<string, unknown>,
	credentials: Record<string, unknown>,
	credentialDescription: Record<string, unknown>,
): Record<string, unknown> {
	const authentication = asRecord(credentialDescription.authenticate);
	if (authentication?.type !== 'generic' || !asRecord(authentication.properties)) {
		throw new Error('Squared currently supports n8n generic credential authentication properties only');
	}
	const authenticated = { ...requestOptions };
	const propertyMap = authentication.properties as Record<string, unknown>;
	for (const target of ['headers', 'qs', 'body']) {
		const configured = asRecord(propertyMap[target]);
		if (!configured) continue;
		const destinationKey = target === 'qs' && requestOptions.qs === undefined && requestOptions.query !== undefined ? 'query' : target;
		const destination = isRecord(authenticated[destinationKey]) ? { ...authenticated[destinationKey] as Record<string, unknown> } : {};
		for (const [rawName, rawValue] of Object.entries(configured)) {
			const name = resolveCredentialExpression(rawName, credentials);
			if (typeof name !== 'string' || !name) throw new Error(`Credential authentication produced an invalid ${target} field name`);
			(destination as Record<string, unknown>)[name] = resolveCredentialValue(rawValue, credentials);
		}
		(authenticated as Record<string, unknown>)[destinationKey] = destination;
	}
	return authenticated;
}

function resolveCredentialValue(value: unknown, credentials: Record<string, unknown>): unknown {
	if (typeof value === 'string') return value.includes('{{') || value.startsWith('=')
		? evaluateN8nExpression(value, { item: { json: {} }, credentials })
		: value;
	if (Array.isArray(value)) return value.map((item) => resolveCredentialValue(item, credentials));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveCredentialValue(item, credentials)]));
	return value;
}

function resolveCredentialExpression(value: string, credentials: Record<string, unknown>): unknown {
	return value.includes('{{') || value.startsWith('=')
		? evaluateN8nExpression(value, { item: { json: {} }, credentials })
		: value;
}

function getSupportedVersions(wrapper: VersionedTypeLike, description: Record<string, unknown>): number[] {
	const mapVersions = Object.keys(wrapper.nodeVersions ?? {}).map(Number).filter(Number.isFinite);
	if (mapVersions.length) return mapVersions.sort((a, b) => a - b);
	const declared = description.version;
	const versions = Array.isArray(declared) ? declared : [declared ?? wrapper.currentVersion ?? description.defaultVersion ?? 1];
	const result = versions.map(Number).filter((version) => Number.isFinite(version) && version > 0);
	return [...new Set(result.length ? result : [1])].sort((a, b) => a - b);
}

function selectNodeType(wrapper: VersionedTypeLike, version: number): NodeTypeLike {
	if (typeof wrapper.getNodeType === 'function') return wrapper.getNodeType(version);
	return wrapper;
}

function classifyRuntimeExecution(description: Record<string, unknown>): CatalogNode['executionType'] {
	if (Array.isArray(description.webhooks) && description.webhooks.length) return 'webhook';
	if (description.polling === true) return 'poll';
	if (description.requestDefaults !== undefined || description.requestOperations !== undefined) return 'declarative';
	return 'execute';
}

function scanRuntimeContracts(source: string, executable: boolean): string[] {
	const methods = [...source.matchAll(/\bthis\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]).filter((name): name is string => Boolean(name));
	return [...new Set(['INodeType', ...(executable ? ['IExecuteFunctions'] : []), ...methods.map((method) => `IExecuteFunctions.${method}`)])].sort();
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

