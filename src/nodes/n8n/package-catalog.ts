import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export type CompatibilityStage = 'discovered' | 'loaded' | 'configurable' | 'executable' | 'validated';

export interface NodeCompatibilityState {
	discovered: boolean;
	loaded: boolean;
	configurable: boolean;
	executable: boolean;
	validated: boolean;
}

export interface CatalogNode {
	packageName: string;
	packageVersion: string;
	license: string;
	enterpriseRestricted: boolean;
	nodeType: string;
	nodeName: string;
	manifestPath: string;
	descriptionPath: string;
	version: number | number[] | null;
	executionType: 'execute' | 'declarative' | 'supplyData' | 'trigger' | 'poll' | 'webhook' | 'unknown';
	dependencies: string[];
	interfacesUsed: string[];
	compatibility: NodeCompatibilityState;
	knownFailures: string[];
	description?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	validationEvidence?: Array<{
		typeVersion: number;
		test: string;
		operation?: string;
		contracts?: string[];
		expected?: unknown;
		observed?: unknown;
		status: 'passed';
	}>;
}

export interface CatalogCredential {
	packageName: string;
	packageVersion: string;
	license: string;
	enterpriseRestricted: boolean;
	credentialName: string;
	credentialType: string;
	version: number | number[] | null;
	manifestPath: string;
	descriptionPath: string;
	loaded: boolean;
	configurable: boolean;
	knownFailures: string[];
	description?: Record<string, unknown>;
}

interface PackageManifest {
	name?: string;
	version?: string;
	license?: string;
	dependencies?: Record<string, string>;
	n8n?: { nodes?: string[]; credentials?: string[] };
}

/**
 * Reads generated n8n package manifests and JSON descriptions without importing
 * package code. Static parameter metadata can make a node configurable, while
 * only an imported runtime class is marked loaded.
 */
export class N8nPackageCatalog {
	private readonly nodes = new Map<string, CatalogNode>();
	private readonly credentials = new Map<string, CatalogCredential>();
	private readonly packageNames = new Set<string>();
	private readonly caseInsensitiveDirectoryEntries = new Map<string, Promise<string[]>>();
	private readonly packagesDirectory: string;

	constructor(packagesDirectory: string) { this.packagesDirectory = packagesDirectory; }

	async discover(): Promise<{ packages: string[]; nodes: CatalogNode[]; credentials: CatalogCredential[] }> {
		this.nodes.clear();
		this.credentials.clear();
		this.packageNames.clear();
		this.caseInsensitiveDirectoryEntries.clear();
		const packageDirectories = await findPackageDirectories(resolve(this.packagesDirectory));
		for (const packageDirectory of packageDirectories) {
			const packageJsonPath = join(packageDirectory, 'package.json');
			const manifest = await readJson<PackageManifest>(packageJsonPath).catch(() => null);
			if (!manifest?.name || !manifest.n8n) continue;
			const packageName = manifest.name;
			this.packageNames.add(packageName);
			const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
			for (const path of manifest.n8n.nodes ?? []) {
				const safePath = resolvePackagePath(packageDirectory, path);
				const enterpriseRestricted = isEnterpriseSourcePath(path);
				const descriptionPath = safePath.replace(/\.node\.ee\.js$/i, '.node.ee.json').replace(/\.node\.js$/i, '.node.json');
				const item: CatalogNode = {
					packageName,
					packageVersion: manifest.version ?? 'unknown',
					license: enterpriseRestricted ? 'LicenseRef-n8n-enterprise' : manifest.license ?? 'unknown',
					enterpriseRestricted,
					nodeType: `${packageName}.${lowerFirst(basenameWithoutExtension(path))}`,
					nodeName: basenameWithoutExtension(path),
					manifestPath: relative(resolve(this.packagesDirectory), safePath),
					descriptionPath,
					version: null,
					executionType: 'unknown',
					dependencies,
					interfacesUsed: [],
					compatibility: { discovered: true, loaded: false, configurable: false, executable: false, validated: false },
					knownFailures: [
						'Node code is discovered but has not been loaded into the runtime.',
						...(enterpriseRestricted ? ['Enterprise-restricted .ee. source is excluded from Squared distribution and metadata loading.'] : []),
					],
				};
				this.nodes.set(`${packageName}:${path}`, item);
			}
			for (const path of manifest.n8n.credentials ?? []) {
				const safePath = resolvePackagePath(packageDirectory, path);
				const enterpriseRestricted = isEnterpriseSourcePath(path);
				const item: CatalogCredential = {
					packageName,
					license: enterpriseRestricted ? 'LicenseRef-n8n-enterprise' : manifest.license ?? 'unknown',
					enterpriseRestricted,
					credentialName: basenameWithoutExtension(path),
					credentialType: lowerFirst(basenameWithoutExtension(path)),
					version: null,
					packageVersion: manifest.version ?? 'unknown',
					manifestPath: relative(resolve(this.packagesDirectory), safePath),
					descriptionPath: safePath.replace(/\.credentials\.ee\.js$/i, '.credentials.ee.json').replace(/\.credentials\.js$/i, '.credentials.json'),
					loaded: false,
					configurable: false,
					knownFailures: [
						'Credential schemas are not loaded from compiled package metadata yet.',
						...(enterpriseRestricted ? ['Enterprise-restricted .ee. source is excluded from Squared distribution and metadata loading.'] : []),
					],
				};
				this.credentials.set(`${packageName}:${path}`, item);
			}
		}
		return this.snapshot();
	}

	async loadDescriptions(): Promise<{ nodes: CatalogNode[]; credentials: CatalogCredential[] }> {
		for (const node of this.nodes.values()) {
			if (node.enterpriseRestricted) continue;
			const description = await readJsonWithCaseInsensitiveFallback<Record<string, unknown>>(node.descriptionPath, this.caseInsensitiveDirectoryEntries).catch(() => null);
			if (!description) {
				node.knownFailures = [...new Set([...node.knownFailures, 'Generated node description JSON is missing or unreadable.'])];
				continue;
			}
			const payload = asObject(description.node) ?? description;
			node.metadata = description;
			// The .node.json file shipped in current n8n packages is editor/search
			// metadata. It is not the executable INodeTypeDescription.
			const declaredType = typeof description.node === 'string' ? description.node : undefined;
			node.nodeType = declaredType ?? (typeof payload.name === 'string' ? payload.name : `${node.packageName}.${node.nodeName}`);
			node.version = parseVersion(payload.version ?? payload.defaultVersion);
			node.executionType = classifyExecutionType(payload);
			node.compatibility.configurable = Array.isArray(payload.properties);
			if (!node.compatibility.configurable) node.knownFailures.push('Static node metadata has no parameter properties array.');
			node.knownFailures = node.knownFailures.filter((failure) => failure !== 'Generated node description JSON is missing or unreadable.');
		}
		for (const credential of this.credentials.values()) {
			if (credential.enterpriseRestricted) continue;
			const description = await readJsonWithCaseInsensitiveFallback<Record<string, unknown>>(credential.descriptionPath, this.caseInsensitiveDirectoryEntries).catch(() => null);
			if (!description) continue;
			credential.description = asObject(description.credential) ?? description;
			credential.loaded = true;
			credential.configurable = Array.isArray(credential.description.properties);
			credential.knownFailures = credential.configurable ? [] : ['Credential description has no properties array.'];
		}
		return { nodes: [...this.nodes.values()], credentials: [...this.credentials.values()] };
	}

	markCredentialLoaded(credentialType: string, description: Record<string, unknown>): void {
		const credential = [...this.credentials.values()].find((item) => item.credentialType === credentialType);
		if (!credential) return;
		credential.credentialType = typeof description.name === 'string' ? description.name : credential.credentialType;
		credential.version = parseVersion(description.version);
		credential.description = description;
		credential.loaded = true;
		credential.configurable = Array.isArray(description.properties);
		credential.knownFailures = credential.configurable ? [] : ['Runtime credential description has no properties array.'];
	}

	markRuntimeLoaded(
		nodeType: string,
		description: Record<string, unknown>,
		executionType: CatalogNode['executionType'],
		interfacesUsed: string[],
		executable: boolean,
		supportedVersions?: number[],
	): void {
		const node = [...this.nodes.values()].find((item) => item.nodeType === nodeType);
		if (!node) return;
		node.description = description;
		node.version = supportedVersions?.length ? [...supportedVersions] : parseVersion(description.version ?? description.defaultVersion);
		node.executionType = executionType;
		node.interfacesUsed = [...new Set(interfacesUsed)].sort();
		node.compatibility.loaded = true;
		node.compatibility.configurable = Array.isArray(description.properties);
		node.compatibility.executable = executable;
		node.knownFailures = node.knownFailures.filter((failure) => ![
			'Node code is discovered but has not been loaded into the runtime.',
			'Generated node description JSON is missing or unreadable.',
			'Static node metadata has no parameter properties array.',
			'Node description has no properties array.',
			'No successful node execution has exercised this node version against Squared contracts yet.',
		].includes(failure) && !failure.startsWith('Node module load failed:') && !failure.startsWith('Runtime class has no supported lifecycle method:') && (executable || (!failure.startsWith('Node method failed before producing') && !failure.startsWith('Required runtime contract is unavailable:'))));
		if (!node.compatibility.configurable) node.knownFailures.push('Runtime node description has no properties array.');
		if (!executable) node.knownFailures.push('No successful node execution has exercised this node version against Squared contracts yet.');
	}

	markValidated(nodeType: string, typeVersion: number, test: string): void {
		this.markValidatedWithEvidence(nodeType, { typeVersion, test, operation: 'unspecified', contracts: [], expected: null, observed: null, status: 'passed' });
	}

	markValidatedWithEvidence(nodeType: string, evidence: {
		typeVersion: number;
		test: string;
		operation: string;
		contracts: string[];
		expected: unknown;
		observed: unknown;
		status: 'passed';
	}): void {
		const node = [...this.nodes.values()].find((item) => item.nodeType === nodeType);
		if (!node || !node.compatibility.executable) throw new Error(`Cannot validate node before its runtime contract is executable: ${nodeType}`);
		const validationEvidence = node.validationEvidence ?? [];
		if (!validationEvidence.some((item) => item.typeVersion === evidence.typeVersion && item.test === evidence.test)) {
			validationEvidence.push(evidence);
		}
		node.validationEvidence = validationEvidence;
		node.compatibility.validated = true;
	}

	markExecutionFailure(nodeType: string, error: unknown): void {
		const node = [...this.nodes.values()].find((item) => item.nodeType === nodeType);
		if (!node) return;
		node.compatibility.executable = false;
		const detail = error instanceof Error ? error.message : String(error);
		const missingContract = detail.match(/n8n (?:IExecuteFunctions|IPollFunctions|ITriggerFunctions|IWebhookFunctions)(?:\.helpers)?\.[A-Za-z_$][\w$]*/)?.[0];
		const reason = missingContract
			? `Required runtime contract is unavailable: ${missingContract}`
			: `Node method failed before producing a successful result (${error instanceof Error ? error.name : 'Error'}).`;
		node.knownFailures = [...new Set([...node.knownFailures.filter((item) => !item.startsWith('Node method failed before producing') && !item.startsWith('Required runtime contract is unavailable:')), reason])];
	}

	markRuntimeLoadFailure(nodeType: string, error: unknown): void {
		const node = [...this.nodes.values()].find((item) => item.nodeType === nodeType);
		if (!node) return;
		node.compatibility.loaded = false;
		node.compatibility.executable = false;
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		const reason = `Node module load failed: ${detail}`;
		node.knownFailures = [...new Set([...node.knownFailures.filter((item) => !item.startsWith('Node module load failed:')), reason])];
	}

	markRuntimeNoSupportedLifecycle(nodeType: string): void {
		const node = [...this.nodes.values()].find((item) => item.nodeType === nodeType);
		if (!node) return;
		node.compatibility.executable = false;
		const reason = 'Runtime class has no supported lifecycle method: execute, trigger, poll, webhook, supplyData, or declarative REST routing.';
		node.knownFailures = [...new Set([...node.knownFailures.filter((item) => !item.startsWith('No successful node execution has exercised') && !item.startsWith('Runtime class has no supported lifecycle method:')), reason])];
	}

	markExecutable(nodeType: string): void {
		const node = [...this.nodes.values()].find((item) => item.nodeType === nodeType);
		if (!node) return;
		node.compatibility.executable = true;
		node.knownFailures = node.knownFailures.filter((failure) =>
			!failure.startsWith('No successful node execution has exercised') &&
			!failure.startsWith('Node method failed before producing') &&
			!failure.startsWith('Required runtime contract is unavailable:'));
	}

	assertExecutable(nodeType: string): CatalogNode {
		const entry = [...this.nodes.values()].find((node) => node.nodeType === nodeType);
		if (!entry) throw new Error(`Node type was not discovered: ${nodeType}`);
		if (!entry.compatibility.executable) throw new Error(`Node ${nodeType} has not passed runtime loading and execution-contract checks`);
		return entry;
	}

	snapshot(): { packages: string[]; nodes: CatalogNode[]; credentials: CatalogCredential[] } {
		return {
			packages: [...this.packageNames].sort(),
			nodes: [...this.nodes.values()].map((node) => ({ ...node, dependencies: [...node.dependencies], interfacesUsed: [...node.interfacesUsed], compatibility: { ...node.compatibility }, knownFailures: [...node.knownFailures] })),
			credentials: [...this.credentials.values()].map((credential) => ({ ...credential, knownFailures: [...credential.knownFailures] })),
		};
	}
}

async function findPackageDirectories(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const directories: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
		const entryPath = join(root, entry.name);
		if (entry.name.startsWith('@')) {
			const scoped = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
			for (const child of scoped) {
				if (child.isDirectory() && !child.isSymbolicLink()) directories.push(join(entryPath, child.name));
			}
		} else {
			directories.push(entryPath);
		}
	}
	return directories.sort();
}

function resolvePackagePath(packageDirectory: string, relativePath: string): string {
	if (isAbsolute(relativePath)) throw new Error('Node manifest paths must be relative');
	const result = resolve(packageDirectory, relativePath);
	const prefix = `${resolve(packageDirectory)}${sep}`;
	if (!result.startsWith(prefix)) throw new Error('Node manifest path escapes its package directory');
	return result;
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readJsonWithCaseInsensitiveFallback<T>(path: string, directoryEntriesCache: Map<string, Promise<string[]>>): Promise<T> {
	try {
		return await readJson<T>(path);
	} catch (error) {
		const actualPath = await resolveCaseInsensitivePath(path, directoryEntriesCache).catch(() => null);
		if (!actualPath || actualPath === path) throw error;
		return readJson<T>(actualPath);
	}
}

async function resolveCaseInsensitivePath(path: string, directoryEntriesCache: Map<string, Promise<string[]>>): Promise<string | null> {
	const absolutePath = resolve(path);
	const root = parse(absolutePath).root;
	let current = root;
	for (const segment of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
		let entriesPromise = directoryEntriesCache.get(current);
		if (!entriesPromise) {
			entriesPromise = readdir(current).catch(() => []);
			directoryEntriesCache.set(current, entriesPromise);
		}
		const entries = await entriesPromise;
		const actualSegment = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
		if (!actualSegment) return null;
		current = join(current, actualSegment);
	}
	return current;
}

function basenameWithoutExtension(path: string): string {
	const file = path.split(/[\\/]/).at(-1) ?? path;
	return file.replace(/\.(?:node|credentials)(?:\.ee)?\.js$/i, '').replace(/\.js$/i, '');
}

function lowerFirst(value: string): string { return value ? value[0]!.toLowerCase() + value.slice(1) : value; }

function isEnterpriseSourcePath(path: string): boolean {
	return path.split(/[\\/]/).some((part) => /\.ee(?:\.|$)/i.test(part));
}

function parseVersion(value: unknown): number | number[] | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (Array.isArray(value) && value.every((version) => typeof version === 'number' && Number.isFinite(version))) {
		return value as number[];
	}
	return null;
}

function classifyExecutionType(description: Record<string, unknown>): CatalogNode['executionType'] {
	if (Array.isArray(description.webhooks) && description.webhooks.length > 0) return 'webhook';
	if (description.polling === true) return 'poll';
	if (description.requestDefaults !== undefined || description.requestOperations !== undefined) return 'declarative';
	if (description.triggerPanel !== undefined || description.eventTriggerDescription !== undefined) return 'trigger';
	return 'unknown';
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
