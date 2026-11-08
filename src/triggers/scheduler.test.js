import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowScheduler } from './scheduler.js';

test('scheduler submits active interval workflows and stops cleanly', async () => {
	const calls = [];
	const store = {
		async listScheduleWorkflows() {
			return [{
				id: 'scheduled-workflow',
				active: true,
				lastScheduledAt: null,
				nodes: [{ type: 'trigger.schedule', parameters: { intervalSeconds: 5 } }],
			}];
		},
	};
	const scheduler = new WorkflowScheduler({
		store,
		workflowService: { async execute(...args) { calls.push(args); } },
		pollMs: 1_000,
	});
	scheduler.start();
	await new Promise((resolve) => setTimeout(resolve, 20));
	scheduler.stop();
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], 'scheduled-workflow');
	assert.equal(calls[0][1], 'schedule');
});
