import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflow } from './definition.js';

test('workflow definition accepts a trigger and ordered nodes', () => {
	const workflow = normalizeWorkflow({
		name: 'hello', active: false,
		nodes: [
			{ id: 'trigger', type: 'trigger.manual', name: 'Manual', parameters: {} },
			{ id: 'set', type: 'data.set', name: 'Set', parameters: { values: { value: 1 } } },
		],
	}, 'workflow-1');
	assert.equal(workflow.id, 'workflow-1');
	assert.equal(workflow.nodes.length, 2);
});

test('workflow definition rejects duplicate IDs, misplaced triggers, and tiny schedules', () => {
	const node = { id: 'same', type: 'trigger.manual', name: 'Manual', parameters: {} };
	assert.throws(() => normalizeWorkflow({ name: 'bad', nodes: [node, { ...node }] }), /unique/);
	assert.throws(() => normalizeWorkflow({ name: 'bad', nodes: [node, { ...node, id: 'action', type: 'trigger.webhook' }] }), /Only the first node/);
	assert.throws(() => normalizeWorkflow({ name: 'bad', nodes: [{ ...node, type: 'trigger.schedule', parameters: { intervalSeconds: 1 } }] }), /between 5 and 86400/);
});
