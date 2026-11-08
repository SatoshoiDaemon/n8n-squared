import { performance } from 'node:perf_hooks';
import { evaluateValue } from '../../src/expressions/evaluate.js';
import { ExecutionEngine } from '../../src/execution/engine.js';

const iterations = Number(process.env.SQUARED_BENCHMARK_ITERATIONS || 300);
if (!Number.isInteger(iterations) || iterations < 10 || iterations > 10_000) {
	throw new Error('SQUARED_BENCHMARK_ITERATIONS must be an integer from 10 to 10000');
}
const warmupIterations = Math.min(200, Math.max(25, Math.floor(iterations * 0.2)));

globalThis.gc?.();
const memoryBefore = process.memoryUsage();
const importStart = performance.now();
const [{ GraphExecutionEngine, NodeAdapterRegistry }, { N8nPackageCatalog }] = await Promise.all([
	import('../../src/execution/graph-engine.ts'),
	import('../../src/nodes/n8n/package-catalog.ts'),
]);
const moduleImportMs = performance.now() - importStart;
globalThis.gc?.();
const memoryAfter = process.memoryUsage();

const workflow = {
	id: 'benchmark-linear',
	name: 'Squared engine compatibility benchmark',
	active: false,
	nodes: [
		{ id: 'manual', name: 'Manual', type: 'trigger.manual', parameters: {} },
		{ id: 'set', name: 'Set', type: 'data.set', parameters: { values: { result: '={{$json.value}}' } } },
	],
};

const graphRegistry = new NodeAdapterRegistry();
graphRegistry.register({
	type: 'data.set',
	versions: [1],
	async execute(context) {
		return [context.getInputData().map((item, index) => {
			const result = context.getNodeParameter('values.result', index);
			return { ...item, json: { ...item.json, result } };
		})];
	},
});
const graphEngine = new GraphExecutionEngine(graphRegistry);
for (let index = 0; index < warmupIterations; index += 1) {
	const result = await graphEngine.execute(workflow, { input: { value: -index } });
	if (result.status !== 'succeeded' || result.output[0]?.json.result !== -index) throw new Error('Graph engine benchmark warmup produced an incorrect result');
}
const graphSamples = [];
const graphStart = performance.now();
for (let index = 0; index < iterations; index += 1) {
	const start = performance.now();
	const result = await graphEngine.execute(workflow, { input: { value: index } });
	graphSamples.push(performance.now() - start);
	if (result.status !== 'succeeded' || result.output[0]?.json.result !== index) throw new Error('Graph engine benchmark produced an incorrect result');
}
const graphTotalMs = performance.now() - graphStart;

class MemoryStore {
	executions = new Map();
	async createExecution(execution) { this.executions.set(execution.id, { ...execution, status: 'queued' }); }
	async startExecution(id) { const execution = this.executions.get(id); execution.status = 'running'; execution.started = performance.now(); }
	async finishExecution(id, output) { const execution = this.executions.get(id); execution.status = 'succeeded'; execution.output = output; execution.durationMs = performance.now() - execution.started; }
	async failExecution(id, error) { const execution = this.executions.get(id); execution.status = 'failed'; execution.error = error; }
}

const store = new MemoryStore();
const legacyEngine = new ExecutionEngine({
	store,
	registry: new Map([['data.set', (input, parameters, context) => ({ ...input, result: evaluateValue(parameters.values.result, context) })]]),
	concurrency: 1,
	maxQueued: iterations + 1,
});
for (let index = 0; index < warmupIterations; index += 1) await legacyEngine.submit(workflow, 'manual', { value: -index });
await legacyEngine.drain();
store.executions.clear();
const legacyStart = performance.now();
const submitted = [];
for (let index = 0; index < iterations; index += 1) submitted.push(await legacyEngine.submit(workflow, 'manual', { value: index }));
await legacyEngine.drain();
const legacyTotalMs = performance.now() - legacyStart;
const legacySamples = submitted.map(({ id }) => store.executions.get(id)?.durationMs ?? 0);
if (submitted.some(({ id }, index) => store.executions.get(id)?.output?.result !== index)) throw new Error('Legacy engine benchmark produced an incorrect result');

const report = {
	nodeVersion: process.versions.node,
	iterations,
	warmupIterationsPerEngine: warmupIterations,
	moduleLoad: {
		modules: ['graph-engine.ts', 'n8n-expression.ts', 'n8n-format.ts', 'package-catalog.ts'],
		elapsedMs: round(moduleImportMs),
		rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
	heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
		externalDeltaBytes: memoryAfter.external - memoryBefore.external,
	},
	graphEngine: {
		...summarize(graphSamples),
		endToEndTotalMs: round(graphTotalMs),
		endToEndThroughputPerSecond: round(iterations * 1000 / graphTotalMs),
	},
	legacyEngine: {
		endToEndTotalMs: round(legacyTotalMs),
		throughputPerSecond: round(iterations * 1000 / legacyTotalMs),
		nodeExecutionMs: summarize(legacySamples),
	},
	limitations: [
		'Synthetic one-item, two-node workflow using an in-memory store and no network or binary payloads.',
		'RSS and heap deltas are one-process samples; they are not steady-state production measurements.',
		'This benchmark invokes the graph engine directly; it excludes the production queue, persistent database, HTTP server, and Square Cloud process.',
	],
};
console.log(JSON.stringify(report, null, 2));

function summarize(samples) {
	const sorted = [...samples].sort((left, right) => left - right);
	const totalMs = samples.reduce((total, value) => total + value, 0);
	return {
		count: samples.length,
		meanMs: round(totalMs / samples.length),
		p50Ms: round(percentile(sorted, 0.50)),
		p95Ms: round(percentile(sorted, 0.95)),
		throughputPerSecond: round(samples.length * 1000 / totalMs),
	};
}

function percentile(sorted, fraction) {
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value) {
	return Math.round(value * 1000) / 1000;
}
