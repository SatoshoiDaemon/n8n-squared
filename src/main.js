import { loadConfig } from './config.js';
import { AdminAuthService } from './auth/service.js';
import { CredentialVault } from './credentials/vault.js';
import { loadOrCreateEncryptionKey } from './persistence/persistent-secrets.js';
import { ExecutionEngine } from './execution/engine.js';
import { createHttpServer } from './http/server.js';
import { createNodeRegistry } from './nodes/registry.js';
import { createStore } from './persistence/store.js';
import { installShutdownHandlers } from './process/lifecycle.js';
import { WorkflowScheduler } from './triggers/scheduler.js';
import { WorkflowService } from './workflows/service.js';
import { GraphExecutionEngine, NodeAdapterRegistry } from './execution/graph-engine.ts';
import { N8nNodePackageRuntime } from './nodes/n8n/runtime.ts';
import { ensureN8nPackages } from './nodes/n8n/package-installer.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersistentBinaryDataStore } from './persistence/binary-data-store.js';
import { createSquaredCredentialProvider } from './nodes/n8n/credential-provider.ts';

const config = loadConfig();
const product = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const store = createStore(config);

async function start() {
	await store.connect();
	const encryptionKey = await loadOrCreateEncryptionKey(config.dataDir, config.encryptionKey);
	const vault = new CredentialVault(encryptionKey);
	const auth = new AdminAuthService({ store, dataDir: config.dataDir });
	await auth.initialize();
	const registry = createNodeRegistry({
		requestTimeoutMs: config.requestTimeoutMs,
		maxResponseBytes: config.maxResponseBytes,
		getCredential: async (id) => {
			const credential = await store.getCredential(id);
			return credential ? vault.open(credential.encryptedValue) : null;
		},
	});
	const n8nPackageInstall = await ensureN8nPackages(config.n8nPackagesDir, {
		seedArchivePath: join(process.cwd(), 'vendor', 'n8n-runtime.tar.br'),
	});
	console.log(`Official n8n runtime packages ${n8nPackageInstall.installed ? 'installed' : 'available'} (${n8nPackageInstall.packages.join(', ')})`);
	const n8nNodeRuntime = new N8nNodePackageRuntime(config.n8nPackagesDir);
	const n8nAdapterRegistry = new NodeAdapterRegistry();
	const n8nPackages = await n8nNodeRuntime.initialize(n8nAdapterRegistry);
	const credentialProvider = createSquaredCredentialProvider({
		async getCredential(id) { return store.getCredential(id); },
		async getCredentialByName(name) {
			const credential = (await store.listCredentials()).find((item) => item.name === name);
			return credential ? store.getCredential(credential.id) : null;
		},
		async updateCredential(id, encryptedValue) { return store.updateCredential(id, encryptedValue); },
	}, vault);
	const graphEngine = new GraphExecutionEngine(n8nAdapterRegistry, credentialProvider, {
		binaryStore: new PersistentBinaryDataStore(join(config.dataDir, 'n8n-binary')),
	});
	const engine = new ExecutionEngine({
		store,
		registry,
		graphEngine,
		concurrency: config.maxConcurrency,
		maxQueued: config.maxQueuedExecutions,
		requestTimeoutMs: config.requestTimeoutMs,
		maxResponseBytes: config.maxResponseBytes,
	});
	const workflows = new WorkflowService(store, engine, n8nNodeRuntime, credentialProvider);
	const scheduler = new WorkflowScheduler({ store, workflowService: workflows, pollMs: config.schedulePollMs });
	const server = createHttpServer({ config: { ...config, version: product.version }, store, workflows, vault, auth, n8nNodeRuntime });
	installShutdownHandlers({ server, scheduler, store, executionEngine: engine });
	server.once('error', (error) => {
		console.error('HTTP server failed', error?.name || 'Error', error?.code || 'unknown');
		scheduler.stop();
		void store.close().finally(() => { process.exitCode = 1; });
	});
	server.listen(config.port, config.host, () => {
		console.log(
			`Squared ${product.version} (Node ${process.versions.node}) listening on http://${config.host}:${config.port}`,
		);
		if (n8nPackages.packages.length) {
			console.log(`Loaded n8n package manifests: ${n8nPackages.packages.join(', ')} (${n8nPackages.nodes.length} nodes discovered)`);
		}
	});
	scheduler.start();
}

start().catch(async (error) => {
	console.error('Squared failed to start', error?.name || 'Error', error?.code || 'unknown');
	await store.close().catch(() => {});
	process.exitCode = 1;
});
