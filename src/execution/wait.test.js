import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEngine } from './engine.js';
import { GraphExecutionEngine, NodeAdapterRegistry } from './graph-engine.ts';

class WaitingStore {
	workflows = new Map();
	executions = new Map();
	staticData = new Map();
	waits = new Map();
	async getWorkflow(id) { return this.workflows.get(id) ?? null; }
	async getWorkflowRuntimeState(id) { return structuredClone(this.staticData.get(id) ?? {}); }
	async saveWorkflowRuntimeState(id, value) { this.staticData.set(id, structuredClone(value)); }
	async createExecution(value) { this.executions.set(value.id, { ...value, status: 'queued' }); }
	async startExecution(id) { this.executions.get(id).status = 'running'; this.waits.delete(id); }
	async suspendExecution(id, state) { this.executions.get(id).status = 'waiting'; this.waits.set(id, structuredClone(state)); }
	async getWaitingExecution(id) {
		const waitState = this.waits.get(id);
		return waitState ? { ...this.executions.get(id), waitState: structuredClone(waitState) } : null;
	}
	async listDueWaitingExecutions(now) {
		return [...this.waits].filter(([, wait]) => wait.resumeAt && Date.parse(wait.resumeAt) <= now)
			.map(([id, waitState]) => ({ ...this.executions.get(id), waitState: structuredClone(waitState) }));
	}
	async finishExecution(id, output) { Object.assign(this.executions.get(id), { status: 'succeeded', output }); }
	async failExecution(id, error) { Object.assign(this.executions.get(id), { status: 'failed', error }); }
}

test('wait nodes suspend, persist static data, and resume into downstream nodes', async () => {
	const store = new WaitingStore();
	const workflow = {
		id: 'workflow-wait',
		name: 'wait and resume',
		nodes: [
			{ id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
			{ id: 'wait', name: 'Wait', type: 'test.wait', typeVersion: 1, parameters: {} },
			{ id: 'output', name: 'Output', type: 'test.output', typeVersion: 1, parameters: {} },
		],
		connections: {
			Manual: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
			Wait: { main: [[{ node: 'Output', type: 'main', index: 0 }]] },
		},
	};
	store.workflows.set(workflow.id, workflow);
	const registry = new NodeAdapterRegistry();
	registry.register({
		type: 'test.wait',
		versions: [1],
		async execute(context) {
			const state = context.getWorkflowStaticData('global');
			state.waitCount = Number(state.waitCount ?? 0) + 1;
			await context.putExecutionToWait(new Date(Date.now() + 60_000), { acceptsResumeRequest: true });
			return [context.getInputData()];
		},
	});
	registry.register({
		type: 'test.output',
		versions: [1],
		async execute(context) {
			const count = context.getWorkflowStaticData('global').waitCount;
			return [context.getInputData().map((item) => ({ ...item, json: { ...item.json, waitCount: count } }))];
		},
	});
	const graphEngine = new GraphExecutionEngine(registry);
	const engine = new ExecutionEngine({ store, registry: new Map(), graphEngine, concurrency: 1, maxQueued: 4 });
	const queued = await engine.submit(workflow, 'manual', { value: 9 });
	await engine.drain();
	assert.equal(store.executions.get(queued.id).status, 'waiting');
	assert.equal(store.staticData.get(workflow.id).flow.waitCount, 1);

	await engine.resumeDueWaits(Date.now() + 120_000);
	await engine.drain();
	const finished = store.executions.get(queued.id);
	assert.equal(finished.status, 'succeeded');
	assert.deepEqual(finished.output.output.map((item) => item.json), [{ value: 9, waitCount: 1 }]);
});
