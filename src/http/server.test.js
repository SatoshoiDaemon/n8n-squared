import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAuthService } from '../auth/service.js';
import { CredentialVault } from '../credentials/vault.js';
import { loadOrCreateEncryptionKey } from '../persistence/persistent-secrets.js';
import { SqliteStore } from '../persistence/sqlite.js';
import { ExecutionEngine } from '../execution/engine.js';
import { createNodeRegistry } from '../nodes/registry.js';
import { createHttpServer } from './server.js';
import { WorkflowService } from '../workflows/service.js';

test('HTTP editor uses first-admin setup and secure sessions for workflow operations', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'squared-http-'));
	const store = new SqliteStore(dataDir);
	await store.connect();
	const encryptionKey = await loadOrCreateEncryptionKey(dataDir);
	const vault = new CredentialVault(encryptionKey);
	const authService = new AdminAuthService({ store, dataDir });
	await authService.initialize();
	const bootstrapCode = await readFile(join(dataDir, 'bootstrap-code'), 'utf8');
	const config = {
		accessToken: 'integration-token-for-tests-32chars',
		maxRequestBytes: 1_048_576,
		requestTimeoutMs: 1_000,
		maxResponseBytes: 1_024,
	};
	const engine = new ExecutionEngine({
		store,
		registry: createNodeRegistry({ ...config, getCredential: async (id) => {
			const credential = await store.getCredential(id);
			return credential ? vault.open(credential.encryptedValue) : null;
		} }),
		concurrency: 1,
		maxQueued: 8,
	});
	const workflows = new WorkflowService(store, engine);
	const server = createHttpServer({ config, store, workflows, vault, auth: authService });
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const base = `http://127.0.0.1:${server.address().port}`;

	try {
		const editor = await fetch(base);
		assert.equal(editor.status, 200);
		assert.match(await editor.text(), /<title>Squared<\/title>/);
		const setupStatus = await fetch(`${base}/api/auth/status`).then((response) => response.json());
		assert.deepEqual(setupStatus, { setupRequired: true, authenticated: false });
		assert.equal((await fetch(`${base}/api/workflows`)).status, 401);

		const invalidSetup = await fetch(`${base}/api/auth/bootstrap`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: 'invalid', email: 'owner@example.test', password: 'a-strong-password-123' }),
		});
		assert.equal(invalidSetup.status, 403);
		assert.equal((await authService.status(null)).setupRequired, true);

		const createdAdmin = await fetch(`${base}/api/auth/bootstrap`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: bootstrapCode, email: 'Owner@Example.test', password: 'a-strong-password-123' }),
		});
		assert.equal(createdAdmin.status, 201);
		const setCookie = createdAdmin.headers.get('set-cookie');
		assert.match(setCookie, /HttpOnly/);
		assert.match(setCookie, /Secure/);
		assert.match(setCookie, /SameSite=Strict/);
		const cookie = setCookie.split(';')[0];
		assert.deepEqual(await fetch(`${base}/api/auth/status`, { headers: { cookie } }).then((response) => response.json()), {
			setupRequired: false,
			authenticated: true,
		});
		assert.equal((await fetch(`${base}/api/workflows`, { headers: { authorization: `Bearer ${config.accessToken}` } })).status, 200);
		assert.equal(await readFile(join(dataDir, 'bootstrap-code'), 'utf8').then(() => true, () => false), false);

		const secondSetup = await fetch(`${base}/api/auth/bootstrap`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: bootstrapCode, email: 'attacker@example.test', password: 'another-strong-password-123' }),
		});
		assert.equal(secondSetup.status, 409);

		const auth = { cookie, 'content-type': 'application/json' };
		const created = await fetch(`${base}/api/workflows`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				name: 'API workflow',
				nodes: [
					{ id: 'manual', type: 'trigger.manual', name: 'Manual', parameters: {} },
					{ id: 'set', type: 'data.set', name: 'Set', parameters: { values: { result: '={{$json.message}}' } } },
				],
			}),
		});
		assert.equal(created.status, 201);
		const workflow = await created.json();

		const n8nImport = {
			id: 'n8n-import-1', name: 'Imported n8n graph', active: true,
			settings: { executionOrder: 'v1', preservedSetting: true }, tags: [{ id: 'tag-1', name: 'kept' }],
		nodes: [
			{ id: 'start', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
			{ id: 'unknown', name: 'Future node', type: 'community.futureNode', typeVersion: 4, position: [200, 0], parameters: { custom: 'kept' }, unknownNodeField: 7 },
		],
		connections: { 'Manual Trigger': { main: [[{ node: 'Future node', type: 'main', index: 0 }]] } },
	};
	const imported = await fetch(`${base}/api/workflows/import`, {
		method: 'POST', headers: auth, body: JSON.stringify(n8nImport),
	});
	assert.equal(imported.status, 201);
	assert.equal((await imported.json()).id, n8nImport.id);
	assert.deepEqual(await fetch(`${base}/api/workflows/${n8nImport.id}/export`, { headers: auth }).then((response) => response.json()), n8nImport);
	const duplicateImport = await fetch(`${base}/api/workflows/import`, {
		method: 'POST', headers: auth, body: JSON.stringify({ ...n8nImport, name: 'Must not replace original' }),
	});
	assert.equal(duplicateImport.status, 409);
	assert.deepEqual(await fetch(`${base}/api/workflows/${n8nImport.id}/export`, { headers: auth }).then((response) => response.json()), n8nImport);
	const concurrentImport = { ...n8nImport, id: 'n8n-import-concurrent', name: 'Concurrent import' };
	const concurrentResults = await Promise.all([1, 2].map(() => fetch(`${base}/api/workflows/import`, {
		method: 'POST', headers: auth, body: JSON.stringify(concurrentImport),
	})));
	assert.deepEqual(concurrentResults.map((response) => response.status).sort(), [201, 409]);
	assert.deepEqual(await fetch(`${base}/api/workflows/${concurrentImport.id}/export`, { headers: auth }).then((response) => response.json()), concurrentImport);

		const crossOrigin = await fetch(`${base}/api/workflows`, {
			method: 'POST',
			headers: { ...auth, origin: 'https://attacker.example' },
			body: JSON.stringify({ name: 'Cross origin', nodes: [] }),
		});
		assert.equal(crossOrigin.status, 403);

		const run = await fetch(`${base}/api/workflows/${workflow.id}/run`, {
			method: 'POST', headers: auth, body: JSON.stringify({ input: { message: 'hello' } }),
		});
		assert.equal(run.status, 202);
		const { id: executionId } = await run.json();
		let execution;
		for (let attempt = 0; attempt < 40; attempt++) {
			execution = await fetch(`${base}/api/executions/${executionId}`, { headers: auth }).then((response) => response.json());
			if (execution.status === 'succeeded' || execution.status === 'failed') break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(execution.status, 'succeeded');
		assert.deepEqual(execution.output, { message: 'hello', result: 'hello' });
		const deletedExecution = await fetch(`${base}/api/executions/${executionId}`, { method: 'DELETE', headers: auth });
		assert.equal(deletedExecution.status, 204);
		assert.equal((await fetch(`${base}/api/executions/${executionId}`, { headers: auth })).status, 404);

		const webhookDefinition = await fetch(`${base}/api/workflows`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				name: 'Webhook workflow', active: true,
				nodes: [
					{ id: 'webhook', type: 'trigger.webhook', name: 'Webhook', parameters: {} },
					{ id: 'set-webhook', type: 'data.set', name: 'Set', parameters: { values: { copied: '={{$json.value}}' } } },
				],
			}),
		});
		const webhookWorkflow = await webhookDefinition.json();
		const webhookResponse = await fetch(`${base}/webhook/${webhookWorkflow.id}`, {
			method: 'POST', headers: auth, body: JSON.stringify({ value: 'triggered' }),
		});
		assert.equal(webhookResponse.status, 202);
		const webhookExecutionId = (await webhookResponse.json()).id;
		let webhookExecution;
		for (let attempt = 0; attempt < 40; attempt++) {
			webhookExecution = await fetch(`${base}/api/executions/${webhookExecutionId}`, { headers: auth }).then((response) => response.json());
			if (webhookExecution.status === 'succeeded' || webhookExecution.status === 'failed') break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(webhookExecution.status, 'succeeded');
		assert.equal(webhookExecution.output.copied, 'triggered');

		const credentialResponse = await fetch(`${base}/api/credentials`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'Test credential', values: { Authorization: 'Bearer hidden-value' } }),
		});
		assert.equal(credentialResponse.status, 201);
		const { id: credentialId } = await credentialResponse.json();
		assert.equal((await store.getCredential(credentialId)).encryptedValue.includes('hidden-value'), false);
		assert.deepEqual(vault.open((await store.getCredential(credentialId)).encryptedValue), { Authorization: 'Bearer hidden-value' });

		const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
		assert.equal(logout.status, 204);
		assert.equal((await fetch(`${base}/api/workflows`, { headers: { cookie } })).status, 401);

		const login = await fetch(`${base}/api/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'owner@example.test', password: 'a-strong-password-123' }),
		});
		assert.equal(login.status, 200);
		const loginCookie = login.headers.get('set-cookie').split(';')[0];
		assert.equal((await fetch(`${base}/api/workflows`, { headers: { cookie: loginCookie } })).status, 200);
		assert.equal((await fetch(`${base}/api/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'owner@example.test', password: 'wrong-password' }),
		})).status, 401);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await store.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});
