import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowGraph, parseWorkflowDocument } from './n8n-format.ts';

test('workflow import keeps unknown n8n metadata and all graph connections intact', () => {
	const source = {
		id: 'external-id',
		name: 'Branches',
		active: true,
		settings: { executionOrder: 'v1', futureFlag: { enabled: true } },
		tags: [{ id: 'tag-1', name: 'kept' }],
		versionId: 'version-4',
		nodes: [
			{ id: 'start-id', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {}, customFutureProperty: 9 },
			{ id: 'left-id', name: 'Left', type: 'n8n-nodes-base.set', typeVersion: 3, position: [100, 0], parameters: { value: 'left' } },
			{ id: 'right-id', name: 'Right', type: 'n8n-nodes-base.set', typeVersion: 3, position: [100, 100], parameters: { value: 'right' } },
			{ id: 'join-id', name: 'Join', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [200, 50], parameters: {} },
		],
		connections: {
			Start: { main: [[{ node: 'Left', type: 'main', index: 0 }, { node: 'Right', type: 'main', index: 0 }]] },
			Left: { main: [[{ node: 'Join', type: 'main', index: 0 }]] },
			Right: { main: [[{ node: 'Join', type: 'main', index: 1 }]] },
		},
	};

	const parsed = parseWorkflowDocument(source);
	const graph = buildWorkflowGraph(parsed);
	assert.deepEqual(parsed, source);
	assert.equal(graph.connections.length, 4);
	assert.equal(graph.incoming.get('Join')?.length, 2);
	assert.equal(graph.outgoing.get('Start')?.[1]?.target.name, 'Right');
	assert.equal(graph.legacyLinear, false);
});

test('legacy Squared node arrays keep their order as implicit edges', () => {
	const graph = buildWorkflowGraph({
		id: 'legacy',
		name: 'Old workflow',
		active: true,
		nodes: [
			{ id: 'trigger', name: 'Manual', type: 'trigger.manual', parameters: {} },
			{ id: 'set', name: 'Set', type: 'data.set', parameters: { values: { value: 1 } } },
		],
	});
	assert.equal(graph.legacyLinear, true);
	assert.equal(graph.connections[0]?.source.name, 'Manual');
	assert.equal(graph.connections[0]?.target.name, 'Set');
});

test('invalid workflow connections are reported without dropping fields', () => {
	assert.throws(() => buildWorkflowGraph({
		name: 'bad',
		nodes: [{ id: 'a', name: 'A', type: 'some-node', parameters: {} }],
		connections: { A: { main: [[{ node: 'Missing', type: 'main', index: 0 }]] } },
	}), /missing node: Missing/);
});
