import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEngine } from './engine.js';
import { createNodeRegistry } from '../nodes/registry.js';

class FakeStore {
	items = new Map();
	async createExecution(execution) { this.items.set(execution.id, { ...execution, status: 'queued' }); }
	async startExecution(id) { this.items.get(id).status = 'running'; }
	async finishExecution(id, output) { Object.assign(this.items.get(id), { status: 'succeeded', output }); }
	async failExecution(id, error) { Object.assign(this.items.get(id), { status: 'failed', error }); }
}

async function waitForTerminal(store, id) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = store.items.get(id);
		if (['succeeded', 'failed'].includes(result.status)) return result;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Timed out waiting for execution');
}

test('execution applies set nodes and preserves the item after a true IF node', async () => {
	const store = new FakeStore();
	const registry = createNodeRegistry({
		requestTimeoutMs: 1000,
		maxResponseBytes: 1024,
		getCredential: async () => null,
	});
	const engine = new ExecutionEngine({ store, registry, concurrency: 1, maxQueued: 2 });
	const workflow = {
		id: 'workflow-1',
		nodes: [
			{ type: 'trigger.manual' },
			{ type: 'data.set', parameters: { values: { answer: '={{$execution.id}}' } }, name: 'Set' },
			{ type: 'logic.if', parameters: { value: '={{$json.answer}}', operation: 'exists' }, name: 'If' },
		],
	};
	const queued = await engine.submit(workflow, 'manual', { hello: 'world' });
	const result = await waitForTerminal(store, queued.id);
	assert.equal(result.status, 'succeeded');
	assert.equal(result.output.hello, 'world');
	assert.equal(result.output.answer, queued.id);
});

test('a false IF node stops the sequence without running later nodes', async () => {
	const store = new FakeStore();
	const engine = new ExecutionEngine({
		store,
		registry: createNodeRegistry({ requestTimeoutMs: 1000, maxResponseBytes: 1024, getCredential: async () => null }),
		concurrency: 1,
		maxQueued: 1,
	});
	const queued = await engine.submit({
		id: 'workflow-2',
		nodes: [
			{ type: 'trigger.manual' },
			{ type: 'logic.if', parameters: { value: '={{$json.allowed}}', operation: 'isTrue' } },
			{ type: 'data.set', parameters: { values: { shouldNotExist: true } } },
		],
	}, 'manual', { allowed: false });
	const result = await waitForTerminal(store, queued.id);
	assert.equal(result.status, 'succeeded');
	assert.equal(result.output, null);
});
