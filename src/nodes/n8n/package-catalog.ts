import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
	executionType: 'execute' | 'declarative' | 'trigger' | 'poll' | 'webhook' | 'unknown';
	dependencies: string[];
	interfacesUsed: string[];
	compatibility: NodeCompatibilityState;
	knownFailures: string[];
	description?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	validationEvidence?: Array<{ typeVersion: number; test: string; status: 'passed' }>;
}

export interface CatalogCredential {
	packageName: string;
	packageVersion: string;
	license: string;
	enterpriseRestricted: boolean;
	credentialName: string;
	credentialType: string;
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
	private readonly packagesDirectory: string;

	constructor(packagesDirectory: string) { this.packagesDirectory = packagesDirectory; }

	async discover(): Promise<{ packages: string[]; nodes: CatalogNode[]; credentials: CatalogCredential[] }> {
		this.nodes.clear();
		this.credentials.clear();
		this.packageNames.clear();
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
			const description = await readJson<Record<string, unknown>>(node.descriptionPath).catch(() => null);
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
			const description = await readJson<Record<string, unknown>>(credential.descriptionPath).catch(() => null);
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
			'Static node metadata has no parameter properties array.',
			'Node description has no properties array.',
			'No successful node execution has exercised this node version against Squared contracts yet.',
		].includes(failure));
		if (!node.compatibility.configurable) node.knownFailures.push('Runtime node description has no properties array.');
		if (!executable) node.knownFailures.push('No successful node execution has exercised this node version against Squared contracts yet.');
	}

	markValidated(nodeType: string, typeVersion: number, test: string): void {
		const node = [...this.nodes.values()].find((item) => item.nodeType === nodeType);
		if (!node || !node.compatibility.executable) throw new Error(`Cannot validate node before its runtime contract is executable: ${nodeType}`);
		const evidence = node.validationEvidence ?? [];
		if (!evidence.some((item) => item.typeVersion === typeVersion && item.test === test)) {
			evidence.push({ typeVersion, test, status: 'passed' });
		}
		node.validationEvidence = evidence;
		node.compatibility.validated = true;
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
