import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphExecutionEngine, NodeAdapterRegistry } from './graph-engine.ts';

function baseWorkflow() {
	return {
		id: 'graph-1',
		name: 'Branch and join',
		active: false,
		settings: { executionOrder: 'v1' },
		nodes: [
			{ id: 'start-id', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
			{ id: 'if-id', name: 'Route', type: 'test.if', typeVersion: 1, parameters: { condition: '={{$json.allow}}' } },
			{ id: 'yes-id', name: 'Yes', type: 'test.set', typeVersion: 1, parameters: { key: 'branch', value: 'yes' } },
			{ id: 'no-id', name: 'No', type: 'test.set', typeVersion: 1, parameters: { key: 'branch', value: 'no' } },
			{ id: 'join-id', name: 'Join', type: 'test.merge', typeVersion: 1, parameters: {} },
		],
		connections: {
			Start: { main: [[{ node: 'Route', type: 'main', index: 0 }]] },
			Route: { main: [[{ node: 'Yes', type: 'main', index: 0 }], [{ node: 'No', type: 'main', index: 0 }]] },
			Yes: { main: [[{ node: 'Join', type: 'main', index: 0 }]] },
			No: { main: [[{ node: 'Join', type: 'main', index: 1 }]] },
		},
	};
}

function registryForBranching() {
	const registry = new NodeAdapterRegistry();
	registry.register({
		type: 'test.if', versions: [1],
		async execute(context) {
			const trueItems = [];
			const falseItems = [];
			for (let index = 0; index < context.getInputData().length; index += 1) {
				const item = context.getInputData()[index];
				(context.getNodeParameter('condition', index) ? trueItems : falseItems).push(item);
			}
			return [trueItems, falseItems];
		},
	});
	registry.register({
		type: 'test.set', versions: [1],
		async execute(context) {
			const key = context.getNodeParameter('key', 0);
			const value = context.getNodeParameter('value', 0);
			return [context.getInputData().map((item) => ({ ...item, json: { ...item.json, [key]: value } }))];
		},
	});
	registry.register({
		type: 'test.merge', versions: [1],
		async execute(context) {
			return [[...context.getInputData(0), ...context.getInputData(1)]];
		},
	});
	return registry;
}

test('graph engine routes both IF outputs and joins data from two input ports', async () => {
	const engine = new GraphExecutionEngine(registryForBranching());
	const result = await engine.execute(baseWorkflow(), { input: [{ json: { allow: true } }, { json: { allow: false } }] });
	assert.equal(result.status, 'succeeded');
	assert.equal(result.workflowId, 'graph-1');
	assert.deepEqual(result.output.map((item) => item.json.branch), ['yes', 'no']);
	assert.equal(result.nodeRuns.find((run) => run.nodeName === 'Join')?.inputItems, 2);
});

test('legacy Squared linear workflows run through the same graph planner', async () => {
	const registry = new NodeAdapterRegistry();
	registry.register({ type: 'data.set', versions: [1], async execute(context) {
		return [context.getInputData().map((item, index) => ({ ...item, json: { ...item.json, answer: context.getNodeParameter('values.answer', index) } }))];
	} });
	const result = await new GraphExecutionEngine(registry).execute({
		id: 'legacy-1', name: 'Old format', active: false,
		nodes: [
			{ id: 'manual', name: 'Manual', type: 'trigger.manual', parameters: {} },
			{ id: 'set', name: 'Set', type: 'data.set', parameters: { values: { answer: '={{$json.value + 1}}' } } },
		],
	}, { input: { value: 4 } });
	assert.equal(result.status, 'succeeded');
	assert.deepEqual(result.output[0]?.json, { value: 4, answer: 5 });
});

test('poll hooks seed real graph execution and trigger hooks persist static data on emit', async () => {
	const registry = new NodeAdapterRegistry();
	registry.register({ type: 'test.poll', versions: [1], async poll(context) {
		return [[{ json: { polled: context.getMode() } }]];
	} });
	registry.register({ type: 'test.trigger', versions: [1], async trigger(context) {
		context.getWorkflowStaticData('global').seen = true;
		await context.emit([[{ json: { event: 'ready' } }]]);
		return { closeFunction() {} };
	} });
	const graphEngine = new GraphExecutionEngine(registry);
	const pollResult = await graphEngine.execute({
		id: 'poll-workflow', name: 'Poll', nodes: [{ id: 'poll', name: 'Poll', type: 'test.poll', typeVersion: 1, parameters: {} }],
	}, { mode: 'poll' });
	assert.equal(pollResult.status, 'succeeded');
	assert.deepEqual(pollResult.output.map((item) => item.json), [{ polled: 'poll' }]);

	const emitted = [];
	const close = await graphEngine.activateTrigger({
		id: 'trigger-workflow', name: 'Trigger', nodes: [{ id: 'trigger', name: 'Trigger', type: 'test.trigger', typeVersion: 1, parameters: {} }],
	}, 'Trigger', async (data, staticData) => emitted.push({ data, staticData }));
	assert.equal(typeof close, 'function');
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].data[0][0].json.event, 'ready');
	assert.deepEqual(emitted[0].staticData, { flow: { seen: true } });
});

test('execution metadata is visible to expressions and returned by the graph result', async () => {
	const registry = new NodeAdapterRegistry();
	registry.register({ type: 'test.metadata', versions: [1], async execute(context) {
		context.setMetadata({ correlationId: 'fixture-run' });
		return [context.getInputData().map((item, index) => ({ ...item, json: {
			...item.json,
			correlationId: context.getMetadata().correlationId,
			expressionValue: context.evaluateExpression('{{$execution.correlationId}}', index),
		} }))];
	} });
	const result = await new GraphExecutionEngine(registry).execute({
		id: 'metadata-workflow', name: 'Execution metadata',
		nodes: [
			{ id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
			{ id: 'metadata', name: 'Metadata', type: 'test.metadata', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'Metadata', type: 'main', index: 0 }]] } },
	}, { input: { value: 3 } });
	assert.equal(result.status, 'succeeded', result.error);
	assert.equal(result.metadata.correlationId, 'fixture-run');
	assert.deepEqual(result.output[0].json, { value: 3, correlationId: 'fixture-run', expressionValue: 'fixture-run' });
});

test('supplyData output flows across ai connections into executable nodes', async () => {
	const registry = new NodeAdapterRegistry();
	registry.register({ type: 'n8n-nodes-base.chatModel', versions: [1], async supplyData() {
		return { ai_languageModel: { response: { provider: 'fixture-model' } } };
	} });
	registry.register({ type: 'n8n-nodes-base.agent', versions: [1], async execute(context) {
		const model = await context.getInputConnectionData('ai_languageModel', 0, 0);
		return [[{ json: { model: model.provider, prompt: context.getInputData()[0].json.prompt } }]];
	} });
	const result = await new GraphExecutionEngine(registry).execute({
		id: 'ai-contract-workflow', name: 'AI data connection',
		nodes: [
			{ id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
			{ id: 'model', name: 'Model', type: 'n8n-nodes-base.chatModel', typeVersion: 1, parameters: {} },
			{ id: 'agent', name: 'Agent', type: 'n8n-nodes-base.agent', typeVersion: 1, parameters: {} },
		],
		connections: {
			Manual: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
			Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
		},
	}, { input: { prompt: 'hello' }, startNode: 'Manual' });
	assert.equal(result.status, 'succeeded', result.error);
	assert.deepEqual(result.output.map((item) => item.json), [{ model: 'fixture-model', prompt: 'hello' }]);
});

test('engine rejects node version mismatches and loops explicitly', async () => {
	const registry = registryForBranching();
	const engine = new GraphExecutionEngine(registry);
	const wrongVersion = baseWorkflow();
	wrongVersion.nodes[1].typeVersion = 2;
	assert.match((await engine.execute(wrongVersion, { input: { allow: true } })).error, /supported versions: 1/);

	const loop = {
		name: 'Loop', nodes: [
			{ id: 'start', name: 'Start', type: 'trigger.manual', parameters: {} },
			{ id: 'set', name: 'Set', type: 'data.set', parameters: {} },
		],
		connections: { Start: { main: [[{ node: 'Set', type: 'main', index: 0 }]] }, Set: { main: [[{ node: 'Start', type: 'main', index: 0 }]] } },
	};
	assert.match((await engine.execute(loop, { input: {}, startNode: 'Start' })).error, /contains a cycle/);
});

test('continueErrorOutput routes the failed item through output port one', async () => {
	const registry = new NodeAdapterRegistry();
	registry.register({ type: 'test.fail', versions: [1], async execute() { throw new Error('controlled failure'); } });
	registry.register({ type: 'test.capture', versions: [1], async execute(context) { return [context.getInputData().map((item) => ({ ...item, json: { ...item.json, caught: item.error?.message } }))]; } });
	const result = await new GraphExecutionEngine(registry).execute({
		name: 'Error route', nodes: [
			{ id: 'start', name: 'Start', type: 'trigger.manual', parameters: {} },
			{ id: 'fail', name: 'Fail', type: 'test.fail', typeVersion: 1, parameters: {}, onError: 'continueErrorOutput' },
			{ id: 'capture', name: 'Capture', type: 'test.capture', typeVersion: 1, parameters: {} },
		],
		connections: {
			Start: { main: [[{ node: 'Fail', type: 'main', index: 0 }]] },
			Fail: { main: [null, [{ node: 'Capture', type: 'main', index: 0 }]] },
		},
	}, { input: { value: 1 } });
	assert.equal(result.status, 'succeeded');
	assert.equal(result.output[0]?.json.caught, 'controlled failure');
});
