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
	execute?: (...args: any[]) => Promise<unknown> | unknown;
	trigger?: (...args: any[]) => Promise<unknown> | unknown;
	poll?: (...args: any[]) => Promise<unknown> | unknown;
	webhook?: (...args: any[]) => Promise<unknown> | unknown;
	supplyData?: (...args: any[]) => Promise<unknown> | unknown;
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
	version?: number | number[];
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

	async getNodeCapabilities(nodeType: string, typeVersion?: number): Promise<{
		version: number;
		description: Record<string, unknown>;
		execute: boolean;
		trigger: boolean;
		poll: boolean;
		webhook: boolean;
		supplyData: boolean;
	}> {
		this.ensureInitialized();
		const record = this.records.get(nodeType);
		if (!record) throw new Error(`n8n node type is not installed: ${nodeType}`);
		const loaded = await this.loadNodeType(record);
		const version = typeVersion ?? loaded.versions.at(-1) ?? 1;
		const selected = selectNodeType(loaded.wrapper, version);
		return {
			version,
			description: selected.description ?? loaded.description,
			execute: typeof selected.execute === 'function',
			trigger: typeof selected.trigger === 'function',
			poll: typeof selected.poll === 'function',
			webhook: typeof selected.webhook === 'function',
			supplyData: typeof selected.supplyData === 'function',
		};
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
			try {
				const selected = selectNodeType(loaded.wrapper, version);
				return ['execute', 'trigger', 'poll', 'webhook', 'supplyData'].some((method) => typeof selected[method] === 'function');
			} catch { return false; }
		});
		if (versions.length === 0) throw new Error(`Node ${record.nodeType} has no executable lifecycle method supported by Squared`);
		const adapter: NodeAdapter = {
			type: record.nodeType,
			versions,
		};
		const invoke = async (method: 'execute' | 'trigger' | 'poll' | 'webhook' | 'supplyData', context: GraphNodeContext): Promise<unknown> => {
				const selected = loaded.wrapper.getNodeType
					? loaded.wrapper.getNodeType(context.node.typeVersion)
					: loaded.wrapper;
				const handler = selected[method];
				if (typeof handler !== 'function') {
					throw new Error(`Node ${record.nodeType}@${context.node.typeVersion ?? 1} does not implement ${method}()`);
				}
				const accessed = new Set<string>();
				const facade = createExecutionFacade(context, loaded.require, selected.description ?? loaded.description, accessed, loaded.runtime);
				let successful = false;
				try {
					const call = handler as (...args: any[]) => unknown;
					const output = call.length ? await call.call(selected, facade) : await call.call(facade);
					successful = true;
					return output;
				} catch (error) {
					loaded.runtime.catalog.markExecutionFailure(record.nodeType, error);
					throw error;
				} finally {
					if (successful) {
						const contracts = ['INodeType', 'IExecuteFunctions', 'INodeExecutionData', ...[...accessed].map((method) => `IExecuteFunctions.${method}`)];
						loaded.runtime.catalog.markRuntimeLoaded(record.nodeType, selected.description ?? loaded.description, method === 'supplyData' ? 'declarative' : method, contracts, true, loaded.versions);
						loaded.runtime.catalog.markExecutable(record.nodeType);
					}
				}
		};
		if (versions.some((version) => typeof selectNodeType(loaded.wrapper, version).execute === 'function')) {
			adapter.execute = async (context) => await invoke('execute', context) as NodeExecutionData[][];
		}
		if (versions.some((version) => typeof selectNodeType(loaded.wrapper, version).trigger === 'function')) {
			adapter.trigger = async (context) => await invoke('trigger', context);
		}
		if (versions.some((version) => typeof selectNodeType(loaded.wrapper, version).poll === 'function')) {
			adapter.poll = async (context) => await invoke('poll', context) as NodeExecutionData[][];
		}
		if (versions.some((version) => typeof selectNodeType(loaded.wrapper, version).webhook === 'function')) {
			adapter.webhook = async (context) => await invoke('webhook', context);
		}
		if (versions.some((version) => typeof selectNodeType(loaded.wrapper, version).supplyData === 'function')) {
			adapter.supplyData = async (context) => {
				const result = asRecord(await invoke('supplyData', context));
				if (!result) throw new Error(`Node ${record.nodeType}@${context.node.typeVersion ?? 1} returned invalid supplyData()`);
				const selected = loaded.wrapper.getNodeType ? loaded.wrapper.getNodeType(context.node.typeVersion) : loaded.wrapper;
				const outputTypes = Array.isArray(selected.description?.outputs) ? selected.description.outputs : loaded.description.outputs;
				const connectionType = Array.isArray(outputTypes)
					? outputTypes.map((output) => typeof output === 'string' ? output : asRecord(output)?.type ?? asRecord(output)?.name).find((output) => typeof output === 'string' && output !== 'main')
					: undefined;
				if (Object.hasOwn(result, 'response') && typeof connectionType === 'string') {
					return { [connectionType]: result as { response: unknown } };
				}
				return result as Record<string, { response: unknown }>;
			};
		}
		return adapter;
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
			try { return ['execute', 'trigger', 'poll', 'webhook', 'supplyData'].some((method) => typeof selectNodeType(wrapper, version)[method] === 'function'); } catch { return false; }
		});
		const interfacesUsed = scanRuntimeContracts(await readFile(entryPath, 'utf8').catch(() => ''), executable);
		this.catalog.markRuntimeLoaded(record.nodeType, description, classifyRuntimeExecution(description, wrapper, versions), interfacesUsed, false, versions);
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
		const normalized = Object.assign(Object.create(Object.getPrototypeOf(description)), description) as Record<string, unknown>;
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
			if (property === 'getNodeInputs') {
				return () => resolveConnectionConfiguration(description.inputs, context.node.parameters ?? {}, 'main', context.node.type);
			}
			if (property === 'getNodeOutputs') {
				return () => resolveConnectionConfiguration(description.outputs, context.node.parameters ?? {}, 'main', context.node.type);
			}
			if (property === 'startJob') {
				return async (taskType: string, payload: Record<string, unknown>, itemIndex = 0) =>
					runPublishedJavaScriptJob(taskType, payload, itemIndex, context, requireFromPackage);
			}
			if (property === 'addExecutionHints') return (..._hints: unknown[]) => undefined;
			if (property === 'helpers' && value && typeof value === 'object') {
				return new Proxy(value as Record<string, unknown>, {
					get(helperTarget, helperProperty, helperReceiver) {
						if (typeof helperProperty === 'string') accessed.add(`helpers.${helperProperty}`);
						const helper = Reflect.get(helperTarget, helperProperty, helperReceiver);
						if (helperProperty === 'detectBinaryEncoding') {
							const chardet = requireFromPackage('chardet') as { detect: (buffer: Buffer) => string | null };
							return (buffer: Buffer) => chardet.detect(buffer) ?? 'utf8';
						}
						if ((helperProperty === 'requestWithAuthentication' || helperProperty === 'httpRequestWithAuthentication') && typeof helper === 'function') {
							return async (credentialType: string, requestOptions: Record<string, unknown>, ...args: unknown[]) => {
								const credentialDescription = await runtime.loadCredentialDescription(credentialType);
								const credentials = await context.getCredentials(credentialType);
								if (isOAuth1Credential(credentialDescription, credentials)) {
									const oauthHelper = Reflect.get(helperTarget, 'requestOAuth1');
									if (typeof oauthHelper === 'function') return oauthHelper.call(helperReceiver, credentialType, requestOptions);
								}
								if (isOAuth2Credential(credentialDescription, credentials)) {
									const oauthHelper = Reflect.get(helperTarget, 'requestOAuth2');
									if (typeof oauthHelper === 'function') return oauthHelper.call(helperReceiver, credentialType, requestOptions, args[0] ?? {});
								}
								if (typeof credentialDescription.authenticate === 'function') {
									const authenticated = await (credentialDescription.authenticate as (...parameters: unknown[]) => Promise<unknown> | unknown)
										.call(credentialDescription, credentials, requestOptions);
									return (Reflect.get(helperTarget, 'httpRequest') as (options: Record<string, unknown>) => Promise<unknown>)(asRecord(authenticated) ?? requestOptions);
								}
								if (!asRecord(credentialDescription.authenticate)) {
									return (helper as (...parameters: unknown[]) => Promise<unknown>).apply(helperReceiver, [credentialType, requestOptions, ...args]);
								}
								const authenticated = applyDeclaredCredentialAuthentication(requestOptions, credentials, credentialDescription);
								return (Reflect.get(helperTarget, 'httpRequest') as (options: Record<string, unknown>) => Promise<unknown>)(authenticated);
							};
						}
						if (helperProperty === 'requestWithAuthenticationPaginated' && typeof helper === 'function') {
							return async (
								requestOptions: Record<string, unknown>,
								itemIndex: number,
								paginationOptions: Record<string, unknown>,
								credentialType?: string,
								...args: unknown[]
							) => {
								if (!credentialType) return (helper as (...parameters: unknown[]) => Promise<unknown>).apply(helperReceiver, [requestOptions, itemIndex, paginationOptions, undefined, ...args]);
								const credentialDescription = await runtime.loadCredentialDescription(credentialType);
								const credentials = await context.getCredentials(credentialType);
								let authenticated = requestOptions;
								if (typeof credentialDescription.authenticate === 'function') {
									const result = await (credentialDescription.authenticate as (...parameters: unknown[]) => Promise<unknown> | unknown)
										.call(credentialDescription, credentials, requestOptions);
									authenticated = asRecord(result) ?? requestOptions;
								} else if (asRecord(credentialDescription.authenticate)) {
									authenticated = applyDeclaredCredentialAuthentication(requestOptions, credentials, credentialDescription);
								} else {
									return (helper as (...parameters: unknown[]) => Promise<unknown>).apply(helperReceiver, [requestOptions, itemIndex, paginationOptions, credentialType, ...args]);
								}
								return (helper as (...parameters: unknown[]) => Promise<unknown>).apply(helperReceiver, [authenticated, itemIndex, paginationOptions, undefined, ...args]);
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

async function runPublishedJavaScriptJob(
	taskType: string,
	payload: Record<string, unknown>,
	itemIndex: number,
	context: GraphNodeContext,
	requireFromPackage: ReturnType<typeof createRequire>,
): Promise<{ ok: true; result: unknown }> {
	if (taskType !== 'javascript') throw new Error(`n8n task type ${taskType} is not supported`);
	const code = typeof payload.code === 'string' ? payload.code : '';
	const nodeMode = String(payload.nodeMode ?? 'runOnceForAllItems');
	const inputItems = context.getInputData();
	const sandboxModule = requireFromPackage('./JavaScriptSandbox.js') as {
		JavaScriptSandbox?: new (
			variables: Record<string, unknown>,
			code: string,
			helpers: Record<string, unknown>,
			options?: Record<string, unknown>,
		) => {
			runCodeAllItems(options?: { multiOutput?: boolean }): Promise<unknown>;
			runCodeEachItem(itemIndex: number): Promise<unknown>;
		};
		vmResolver?: unknown;
	};
	if (typeof sandboxModule.JavaScriptSandbox !== 'function') {
		throw new Error('The published n8n JavaScriptSandbox helper is not available');
	}
	const createSandbox = (currentItemIndex: number) => {
		const currentItem = inputItems[currentItemIndex] ?? { json: {} };
		const input = {
			all: () => inputItems,
			first: () => inputItems[0] ?? { json: {} },
			last: () => inputItems.at(-1) ?? { json: {} },
			item: currentItem,
		};
		const variables = {
			items: inputItems,
			item: currentItem,
			$json: currentItem.json,
			$binary: currentItem.binary ?? {},
			$input: input,
			$execution: { id: context.executionId, mode: context.mode },
			$workflow: { id: context.workflow.id, name: context.workflow.name },
			$node: { id: context.node.id, name: context.node.name, type: context.node.type, typeVersion: context.node.typeVersion },
			$parameter: context.node.parameters ?? {},
		};
		const helpers = {
			normalizeItems(items: unknown[]) {
				const serialized = JSON.stringify(items);
				if (serialized === undefined) throw new Error('n8n JavaScriptSandbox returned data that could not be serialized');
				const normalizeItems = context.helpers.normalizeItems;
				if (typeof normalizeItems !== 'function') throw new Error('n8n IExecuteFunctions.helpers.normalizeItems is not implemented by Squared');
				return normalizeItems(JSON.parse(serialized));
			},
		};
		return new sandboxModule.JavaScriptSandbox!(variables, code, helpers, { resolver: sandboxModule.vmResolver });
	};
	if (nodeMode === 'runOnceForEachItem') {
		const chunk = asRecord(payload.chunk);
		const start = Number(chunk?.startIndex ?? itemIndex);
		const count = Number(chunk?.count ?? inputItems.length);
		const result = [];
		for (let offset = 0; offset < count; offset += 1) {
			result.push(await createSandbox(start + offset).runCodeEachItem(start + offset));
		}
		return { ok: true, result };
	}
	return { ok: true, result: await createSandbox(itemIndex).runCodeAllItems({ multiOutput: payload.multiOutput === true }) };
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

function resolveConnectionConfiguration(
	configured: unknown,
	parameters: Record<string, unknown>,
	defaultType: string,
	nodeType: string,
): Array<string | Record<string, unknown>> {
	if (Array.isArray(configured)) return configured as Array<string | Record<string, unknown>>;
	if (nodeType === 'n8n-nodes-base.merge') {
		const count = Number(parameters.numberInputs);
		return Array.from({ length: Number.isInteger(count) && count > 0 ? Math.min(count, 100) : 2 }, () => ({ type: defaultType }));
	}
	return [{ type: defaultType }];
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

function isOAuth2Credential(description: Record<string, unknown>, credentials: Record<string, unknown>): boolean {
	const name = typeof description.name === 'string' ? description.name.toLowerCase() : '';
	const inherited = Array.isArray(description.extends) ? description.extends.map(String).map((value) => value.toLowerCase()) : [];
	if (name.includes('oauth1') || inherited.includes('oauth1api')) return false;
	return name.includes('oauth2') || inherited.includes('oauth2api') || (isRecord(credentials.oauthTokenData) && typeof credentials.oauthTokenData.access_token === 'string');
}

function isOAuth1Credential(description: Record<string, unknown>, credentials: Record<string, unknown>): boolean {
	const name = typeof description.name === 'string' ? description.name.toLowerCase() : '';
	const inherited = Array.isArray(description.extends) ? description.extends.map(String).map((value) => value.toLowerCase()) : [];
	const tokenData = isRecord(credentials.oauthTokenData) ? credentials.oauthTokenData : {};
	return name.includes('oauth1') || inherited.includes('oauth1api') ||
		(typeof credentials.consumerKey === 'string' && typeof credentials.consumerSecret === 'string' &&
			(typeof credentials.tokenSecret === 'string' || typeof tokenData.oauth_token_secret === 'string'));
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

function classifyRuntimeExecution(description: Record<string, unknown>, wrapper: VersionedTypeLike, versions: number[]): CatalogNode['executionType'] {
	if (Array.isArray(description.webhooks) && description.webhooks.length) return 'webhook';
	const methods = versions.map((version) => selectNodeType(wrapper, version));
	if (description.polling === true || methods.some((type) => typeof type.poll === 'function')) return 'poll';
	if (methods.some((type) => typeof type.trigger === 'function')) return 'trigger';
	if (description.requestDefaults !== undefined || description.requestOperations !== undefined) return 'declarative';
	return 'execute';
}

function scanRuntimeContracts(source: string, executable: boolean): string[] {
	const methods = [...source.matchAll(/\bthis\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]).filter((name): name is string => Boolean(name));
	return [...new Set(['INodeType', ...(executable ? ['IExecuteFunctions'] : []), ...methods.map((method) => `IExecuteFunctions.${method}`)])].sort();
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

