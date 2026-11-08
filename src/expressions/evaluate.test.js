import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateValue } from './evaluate.js';

test('expression resolves nested workflow data and execution metadata', () => {
	const context = { json: { user: { name: 'Ada' } }, executionId: 'exec-1' };
	assert.equal(evaluateValue('={{ $json.user.name }}', context), 'Ada');
	assert.equal(evaluateValue('run-{{$execution.id}} for {{$json.user.name}}', context), 'run-exec-1 for Ada');
});

test('expression keeps object values and rejects arbitrary JavaScript', () => {
	const context = { json: { settings: { retries: 3 } }, executionId: 'exec-1' };
	assert.deepEqual(evaluateValue('={{$json.settings}}', context), { retries: 3 });
	assert.throws(() => evaluateValue('={{ process.exit() }}', context), /Unsupported expression/);
	assert.throws(() => evaluateValue('={{ $json.constructor }}', context), /Invalid expression path/);
});
