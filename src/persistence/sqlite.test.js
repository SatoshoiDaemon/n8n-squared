import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite.js';

test('SQLite preserves workflow runtime state and resumable executions after reconnect', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'squared-runtime-state-'));
	try {
		let store = new SqliteStore(dataDir);
		await store.connect();
		await store.createWorkflow({ id: 'wait-workflow', name: 'wait workflow', active: false, nodes: [] });
		await store.saveWorkflowRuntimeState('wait-workflow', { flow: { count: 4 } });
		await store.createExecution({ id: 'wait-execution', workflowId: 'wait-workflow', triggerType: 'manual', input: {} });
		await store.suspendExecution('wait-execution', {
			nodeName: 'Wait',
			resumeAt: new Date(Date.now() - 1_000).toISOString(),
			acceptsResumeRequest: false,
			input: [{ json: { value: 2 } }],
			metadata: { resumeUrl: '/api/executions/wait-execution/resume' },
		});
		await store.close();

		store = new SqliteStore(dataDir);
		await store.connect();
		assert.deepEqual(await store.getWorkflowRuntimeState('wait-workflow'), { flow: { count: 4 } });
		const waiting = await store.getWaitingExecution('wait-execution');
		assert.equal(waiting.status, 'waiting');
		assert.equal(waiting.waitState.nodeName, 'Wait');
		assert.equal(waiting.waitState.acceptsResumeRequest, false);
		assert.deepEqual(waiting.waitState.input, [{ json: { value: 2 } }]);
		assert.deepEqual(waiting.waitState.metadata, { resumeUrl: '/api/executions/wait-execution/resume' });
		assert.equal((await store.listDueWaitingExecutions()).length, 1);
		await store.close();
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});
