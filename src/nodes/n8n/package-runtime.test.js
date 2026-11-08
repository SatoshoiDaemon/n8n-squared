import test from 'node:test';
import assert from 'node:assert/strict';
import { runN8nBaseCompatibilityProbe } from './compatibility-probe.mjs';
import { ExecutionEngine } from '../../execution/engine.js';
import { GraphExecutionEngine, NodeAdapterRegistry } from '../../execution/graph-engine.ts';
import { N8nNodePackageRuntime } from './runtime.ts';
import { WorkflowService } from '../../workflows/service.js';

const packagesDirectory = process.env.SQUARED_N8N_PACKAGES_DIR;

test('loads and executes real versioned n8n-nodes-base modules', { skip: !packagesDirectory }, async () => {
	const report = await runN8nBaseCompatibilityProbe(packagesDirectory);
	assert.ok(report.nodesDiscovered >= 400);
	assert.equal(report.executions.length, 23);
	assert.ok(report.executions.every((execution) => execution.status === 'passed'));
	assert.equal(report.credentials.find((credential) => credential.credentialType === 'httpHeaderAuth')?.loaded, true);
	assert.equal(report.credentials.find((credential) => credential.credentialType === 'httpHeaderAuth')?.configurable, true);
	assert.equal(report.credentials.find((credential) => credential.credentialType === 'githubApi')?.loaded, true);
	for (const type of [
		'n8n-nodes-base.set', 'n8n-nodes-base.if', 'n8n-nodes-base.filter', 'n8n-nodes-base.switch',
		'n8n-nodes-base.noOp', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.limit', 'n8n-nodes-base.sort',
		'n8n-nodes-base.removeDuplicates', 'n8n-nodes-base.renameKeys', 'n8n-nodes-base.splitOut',
		'n8n-nodes-base.aggregate', 'n8n-nodes-base.dateTime', 'n8n-nodes-base.summarize',
		'n8n-nodes-base.compareDatasets', 'n8n-nodes-base.moveBinaryData', 'n8n-nodes-base.github',
		'n8n-nodes-base.xml', 'n8n-nodes-base.html', 'n8n-nodes-base.markdown',
	]) {
		assert.equal(report.nodes.find((node) => node.nodeType === type)?.compatibility.validated, true, `${type} should carry validation evidence`);
	}
});

test('runs imported n8n workflows through Squared queue and execution history', { skip: !packagesDirectory }, async () => {
	const workflows = new Map();
	const executions = new Map();
	const store = {
		async createWorkflow(workflow) { workflows.set(workflow.id, structuredClone(workflow)); return structuredClone(workflow); },
		async getWorkflow(id) { return workflows.has(id) ? structuredClone(workflows.get(id)) : null; },
		async getWorkflowDefinition(id) { return workflows.get(id) ? structuredClone(workflows.get(id)) : null; },
		async createExecution(execution) { executions.set(execution.id, { ...execution, status: 'queued' }); },
		async startExecution(id) { executions.get(id).status = 'running'; },
		async finishExecution(id, output) { executions.get(id).status = 'succeeded'; executions.get(id).output = output; },
		async failExecution(id, error) { executions.get(id).status = 'failed'; executions.get(id).error = error; },
	};
	const registry = new NodeAdapterRegistry();
	const packageRuntime = new N8nNodePackageRuntime(packagesDirectory);
	await packageRuntime.initialize(registry);
	const graphEngine = new GraphExecutionEngine(registry);
	const engine = new ExecutionEngine({ store, graphEngine, registry: new Map(), concurrency: 1, maxQueued: 4, requestTimeoutMs: 1_000, maxResponseBytes: 1_024 });
	const service = new WorkflowService(store, engine);
	const saved = await service.importN8nWorkflow({
		name: 'Imported real package workflow',
		nodes: [
			{ id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
			{ id: 'noop', name: 'No Operation', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'No Operation', type: 'main', index: 0 }]] } },
	});
	const queued = await service.execute(saved.id, 'manual', { proof: 'real-package' });
	await engine.drain();
	assert.equal(queued.status, 'queued');
	const record = executions.get(queued.id);
	assert.equal(record.status, 'succeeded', record.error);
	assert.deepEqual(record.output.output[0].json, { proof: 'real-package' });
	assert.equal(record.output.nodeRuns.find((run) => run.nodeName === 'No Operation').status, 'succeeded');
});
