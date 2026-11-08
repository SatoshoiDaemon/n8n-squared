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
import { readFile } from 'node:fs/promises';

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
	const engine = new ExecutionEngine({
		store,
		registry,
		concurrency: config.maxConcurrency,
		maxQueued: config.maxQueuedExecutions,
		requestTimeoutMs: config.requestTimeoutMs,
		maxResponseBytes: config.maxResponseBytes,
	});
	const workflows = new WorkflowService(store, engine);
	const scheduler = new WorkflowScheduler({ store, workflowService: workflows, pollMs: config.schedulePollMs });
	const server = createHttpServer({ config: { ...config, version: product.version }, store, workflows, vault, auth });
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
	});
	scheduler.start();
}

start().catch(async (error) => {
	console.error('Squared failed to start', error?.name || 'Error', error?.code || 'unknown');
	await store.close().catch(() => {});
	process.exitCode = 1;
});
