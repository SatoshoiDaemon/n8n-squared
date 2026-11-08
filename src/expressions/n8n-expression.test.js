import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateN8nExpression, resolveParameterTree } from './n8n-expression.ts';

const context = {
	item: { json: { user: { name: 'Ada' }, score: 5 }, binary: { file: { mimeType: 'text/plain' } } },
	inputItems: [{ json: { n: 1 } }, { json: { n: 2 } }],
	priorNodeItems: { Previous: [{ json: { answer: 42 } }] },
	execution: { id: 'exec-1', mode: 'manual' },
	workflow: { id: 'wf-1', name: 'Example' },
	clock: () => new Date('2025-01-02T03:04:05.000Z'),
};

test('expression parser evaluates paths, operators, ternaries, and safe methods', () => {
	assert.equal(evaluateN8nExpression('={{ $json.user.name.toUpperCase() }}', context), 'ADA');
	assert.equal(evaluateN8nExpression('={{ $json.score * 2 + 1 }}', context), 11);
	assert.equal(evaluateN8nExpression('={{ $json.score > 3 ? "yes" : "no" }}', context), 'yes');
	assert.equal(evaluateN8nExpression('={{ $json.missing?.value ?? "fallback" }}', context), 'fallback');
	assert.equal(evaluateN8nExpression('={{ $binary.file.mimeType }}', context), 'text/plain');
	assert.equal(evaluateN8nExpression('={{ $execution.id + "/" + $workflow.id }}', context), 'exec-1/wf-1');
});

test('input and prior node references use the active execution context', () => {
	assert.equal(evaluateN8nExpression('={{ $input.first().json.n + $input.last().json.n }}', context), 3);
	assert.deepEqual(evaluateN8nExpression('={{ $items("Previous") }}', context), [{ json: { answer: 42 } }]);
	assert.equal(evaluateN8nExpression('={{ $node["Previous"].json.answer }}', context), 42);
	assert.equal(evaluateN8nExpression('run {{$json.user.name}} at {{$now}}', context), 'run Ada at 2025-01-02T03:04:05.000Z');
});

test('parameter trees resolve expressions and dynamic code or prototype access is rejected', () => {
	assert.deepEqual(resolveParameterTree({ nested: ['={{$json.score}}', 'x-{{$workflow.name}}'] }, context), {
		nested: [5, 'x-Example'],
	});
	assert.throws(() => evaluateN8nExpression('={{ process.exit() }}', context), /Unknown expression variable/);
	assert.throws(() => evaluateN8nExpression('={{ $json.constructor }}', context), /Invalid property access/);
	assert.throws(() => evaluateN8nExpression('={{ $input.all().map(item => item) }}', context), /Unsupported character/);
});
