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
}

export interface CatalogCredential {
	packageName: string;
	license: string;
	enterpriseRestricted: boolean;
	credentialName: string;
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
 * package code. That makes nodes discoverable/configurable while keeping
 * community JavaScript out of the Squared process until an isolated adapter is
 * available.
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
					license: enterpriseRestricted ? 'LicenseRef-n8n-enterprise' : manifest.license ?? 'unknown',
					enterpriseRestricted,
					nodeType: '',
					nodeName: basenameWithoutExtension(path),
					manifestPath: relative(resolve(this.packagesDirectory), safePath),
					descriptionPath,
					version: null,
					executionType: 'unknown',
					dependencies,
					interfacesUsed: [],
					compatibility: { discovered: true, loaded: false, configurable: false, executable: false, validated: false },
					knownFailures: [
						'Node execution module is not imported; an isolated n8n node adapter has not been implemented.',
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
			node.description = payload;
			node.nodeType = typeof payload.name === 'string' ? payload.name : `${node.packageName}.${node.nodeName}`;
			node.nodeName = typeof payload.displayName === 'string' ? payload.displayName : node.nodeName;
			node.version = parseVersion(payload.version ?? payload.defaultVersion);
			node.executionType = classifyExecutionType(payload);
			node.compatibility.loaded = true;
			node.compatibility.configurable = Array.isArray(payload.properties);
			node.knownFailures = node.knownFailures.filter((failure) => failure !== 'Generated node description JSON is missing or unreadable.');
			if (!node.compatibility.configurable) node.knownFailures.push('Node description has no properties array.');
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

	/**
	 * Refuses to mark executable nodes until package code can run in a properly
	 * isolated process. Metadata visibility is not executable compatibility.
	 */
	assertExecutable(nodeType: string): never {
		const entry = [...this.nodes.values()].find((node) => node.nodeType === nodeType);
		if (!entry) throw new Error(`Node type was not discovered: ${nodeType}`);
		throw new Error(`Node ${nodeType} is not executable: Squared has no isolated n8n node process`);
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
