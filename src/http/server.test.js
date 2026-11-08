import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialVault } from '../credentials/vault.js';
import { ExecutionEngine } from '../execution/engine.js';
import { createNodeRegistry } from '../nodes/registry.js';
import { createHttpServer } from './server.js';
import { WorkflowService } from '../workflows/service.js';

class MemoryStore {
	workflows = new Map();
	executions = new Map();
	credentials = new Map();

	async listWorkflows() { return [...this.workflows.values()]; }
	async getWorkflow(id) { return this.workflows.get(id) ?? null; }
	async saveWorkflow(workflow) {
		const saved = { ...structuredClone(workflow), createdAt: new Date(), updatedAt: new Date() };
		this.workflows.set(workflow.id, saved);
		return saved;
	}
	async deleteWorkflow(id) { return this.workflows.delete(id); }
	async listScheduleWorkflows() { return []; }
	async createExecution(execution) {
		this.executions.set(execution.id, { ...structuredClone(execution), status: 'queued', createdAt: new Date() });
	}
	async startExecution(id) { this.executions.get(id).status = 'running'; }
	async finishExecution(id, output) { Object.assign(this.executions.get(id), { status: 'succeeded', output }); }
	async failExecution(id, error) { Object.assign(this.executions.get(id), { status: 'failed', error }); }
	async getExecution(id) { return this.executions.get(id) ?? null; }
	async listExecutions() { return [...this.executions.values()]; }
	async createCredential(credential) { this.credentials.set(credential.id, credential); }
	async listCredentials() { return [...this.credentials.values()].map(({ id, name }) => ({ id, name })); }
	async getCredential(id) { return this.credentials.get(id) ?? null; }
	async deleteCredential(id) { return this.credentials.delete(id); }
}

test('HTTP API serves the editor, requires a token, and executes a persisted workflow', async () => {
	const store = new MemoryStore();
	const accessToken = 'http-test-token-that-is-long-enough-to-use';
	const vault = new CredentialVault('http test encryption key with more than 32 characters');
	const config = {
		accessToken,
		maxRequestBytes: 1_048_576,
		requestTimeoutMs: 1_000,
		maxResponseBytes: 1_024,
	};
	const engine = new ExecutionEngine({
		store,
		registry: createNodeRegistry({ ...config, getCredential: async () => null }),
		concurrency: 1,
		maxQueued: 8,
	});
	const workflows = new WorkflowService(store, engine);
	const server = createHttpServer({ config, store, workflows, vault });
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	const auth = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };

	try {
		const editor = await fetch(base);
		assert.equal(editor.status, 200);
		assert.match(await editor.text(), /<title>Squared<\/title>/);
		assert.equal((await fetch(`${base}/api/workflows`)).status, 401);

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
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
