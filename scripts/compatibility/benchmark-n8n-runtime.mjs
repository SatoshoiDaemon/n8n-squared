import { performance } from 'node:perf_hooks';
import { GraphExecutionEngine, NodeAdapterRegistry } from '../../src/execution/graph-engine.ts';
import { N8nNodePackageRuntime } from '../../src/nodes/n8n/runtime.ts';

const packagesDirectory = process.env.SQUARED_N8N_PACKAGES_DIR;
if (!packagesDirectory) throw new Error('Set SQUARED_N8N_PACKAGES_DIR to the installed node_modules directory.');
const iterations = Number(process.env.SQUARED_BENCHMARK_ITERATIONS ?? 100);
if (!Number.isInteger(iterations) || iterations < 10 || iterations > 10_000) throw new Error('SQUARED_BENCHMARK_ITERATIONS must be from 10 to 10000');

globalThis.gc?.();
const baseline = process.memoryUsage();
const registry = new NodeAdapterRegistry();
const runtime = new N8nNodePackageRuntime(packagesDirectory);
const catalogStart = performance.now();
const catalog = await runtime.initialize(registry);
const catalogElapsedMs = performance.now() - catalogStart;
globalThis.gc?.();
const afterCatalog = process.memoryUsage();

const workflow = {
	name: 'n8n package runtime benchmark',
	nodes: [
		{ id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
		{ id: 'set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: {
			mode: 'manual', assignments: { assignments: [{ id: 'benchmark', name: 'result', value: '={{$json.value}}', type: 'number' }] }, includeOtherFields: true, options: {},
		} },
	],
	connections: { Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
};
const engine = new GraphExecutionEngine(registry);
globalThis.gc?.();
const beforeNodeImport = process.memoryUsage();
const firstStart = performance.now();
const first = await engine.execute(workflow, { input: { value: 1 } });
const firstExecutionElapsedMs = performance.now() - firstStart;
if (first.status !== 'succeeded' || first.output[0]?.json.result !== 1) throw new Error(`First n8n node execution failed: ${first.error}`);
globalThis.gc?.();
const afterNodeImport = process.memoryUsage();

const warmup = Math.min(50, Math.max(10, Math.floor(iterations / 5)));
for (let index = 0; index < warmup; index += 1) {
	const result = await engine.execute(workflow, { input: { value: index } });
	if (result.status !== 'succeeded' || result.output[0]?.json.result !== index) throw new Error('n8n node warmup returned incorrect data');
}
const samples = [];
const measuredStart = performance.now();
for (let index = 0; index < iterations; index += 1) {
	const start = performance.now();
	const result = await engine.execute(workflow, { input: { value: index } });
	samples.push(performance.now() - start);
	if (result.status !== 'succeeded' || result.output[0]?.json.result !== index) throw new Error('n8n node benchmark returned incorrect data');
}
const measuredElapsedMs = performance.now() - measuredStart;
globalThis.gc?.();
const afterWarmRuns = process.memoryUsage();

const multiNodeWorkflow = {
	name: 'n8n multiple node runtime benchmark',
	nodes: [
		{ id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
		{ id: 'set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: {
			mode: 'manual', assignments: { assignments: [{ id: 'multi-benchmark', name: 'result', value: '={{$json.value}}', type: 'number' }] }, includeOtherFields: true, options: {},
		} },
		{ id: 'date', name: 'Date & Time', type: 'n8n-nodes-base.dateTime', typeVersion: 2, parameters: {
			operation: 'formatDate', date: '2024-01-02T03:04:05.000Z', format: 'yyyy-MM-dd', outputFieldName: 'formattedDate', options: { includeInputFields: true },
		} },
		{ id: 'crypto', name: 'Crypto', type: 'n8n-nodes-base.crypto', typeVersion: 2, parameters: {
			action: 'hash', binaryData: false, value: 'hello', type: 'SHA256', encoding: 'hex', dataPropertyName: 'sha256',
		} },
		{ id: 'merge', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3.2, parameters: { mode: 'append', numberInputs: 2 } },
		{ id: 'noop', name: 'No Operation', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
	],
	connections: {
		Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
		Set: { main: [[{ node: 'Date & Time', type: 'main', index: 0 }]] },
		'Date & Time': { main: [[{ node: 'Crypto', type: 'main', index: 0 }]] },
		Crypto: { main: [[{ node: 'Merge', type: 'main', index: 0 }, { node: 'Merge', type: 'main', index: 1 }]] },
		Merge: { main: [[{ node: 'No Operation', type: 'main', index: 0 }]] },
	},
};
const expectedHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
globalThis.gc?.();
const beforeMultiNodeLoad = process.memoryUsage();
const multiFirstStart = performance.now();
const multiFirst = await engine.execute(multiNodeWorkflow, { input: { value: 1 } });
const multiNodeFirstLoadAndExecutionMs = performance.now() - multiFirstStart;
if (multiFirst.status !== 'succeeded' || multiFirst.output.length !== 2 || multiFirst.output.some((item) => item.json.sha256 !== expectedHash || item.json.formattedDate !== '2024-01-02')) {
	throw new Error(`Multiple-node n8n workflow failed: ${multiFirst.error}`);
}
globalThis.gc?.();
const afterMultiNodeLoad = process.memoryUsage();
for (let index = 0; index < warmup; index += 1) {
	const result = await engine.execute(multiNodeWorkflow, { input: { value: index } });
	if (result.status !== 'succeeded' || result.output.length !== 2) throw new Error('Multiple-node n8n workflow warmup failed');
}
const multiNodeSamples = [];
const multiNodeMeasuredStart = performance.now();
for (let index = 0; index < iterations; index += 1) {
	const start = performance.now();
	const result = await engine.execute(multiNodeWorkflow, { input: { value: index } });
	multiNodeSamples.push(performance.now() - start);
	if (result.status !== 'succeeded' || result.output.length !== 2 || result.output.some((item) => item.json.result !== index)) {
		throw new Error('Multiple-node n8n benchmark returned incorrect output');
	}
}
const multiNodeElapsedMs = performance.now() - multiNodeMeasuredStart;
globalThis.gc?.();
const afterMultiNodeWarmRuns = process.memoryUsage();

console.log(JSON.stringify({
	nodeVersion: process.versions.node,
	package: 'n8n-nodes-base',
	packageVersion: catalog.nodes.find((node) => node.packageName === 'n8n-nodes-base')?.packageVersion,
	iterations,
	warmup,
	catalog: {
		packages: catalog.packages,
		nodesDiscovered: catalog.nodes.filter((node) => node.packageName === 'n8n-nodes-base').length,
		elapsedMs: round(catalogElapsedMs),
		rssDeltaBytes: afterCatalog.rss - baseline.rss,
		heapUsedDeltaBytes: afterCatalog.heapUsed - baseline.heapUsed,
	},
	firstLazyNodeLoadAndExecution: {
		node: 'n8n-nodes-base.set@3.5',
		elapsedMs: round(firstExecutionElapsedMs),
		rssDeltaBytes: afterNodeImport.rss - beforeNodeImport.rss,
		heapUsedDeltaBytes: afterNodeImport.heapUsed - beforeNodeImport.heapUsed,
	},
	warmNodeExecution: {
		count: samples.length,
		meanMs: round(samples.reduce((sum, sample) => sum + sample, 0) / samples.length),
		p50Ms: round(percentile(samples, 0.5)),
		p95Ms: round(percentile(samples, 0.95)),
		throughputPerSecond: round(iterations * 1000 / measuredElapsedMs),
		elapsedMs: round(measuredElapsedMs),
		rssDeltaBytesFromCatalog: afterWarmRuns.rss - afterCatalog.rss,
		heapUsedDeltaBytesFromCatalog: afterWarmRuns.heapUsed - afterCatalog.heapUsed,
	},
	multipleNodeWorkflow: {
		nodes: ['set@3.5', 'dateTime@2', 'crypto@2', 'merge@3.2', 'noOp@1'],
		firstLazyLoadsAndExecutionMs: round(multiNodeFirstLoadAndExecutionMs),
		additionalRssBytesFromBeforeLoad: afterMultiNodeLoad.rss - beforeMultiNodeLoad.rss,
		additionalHeapBytesFromBeforeLoad: afterMultiNodeLoad.heapUsed - beforeMultiNodeLoad.heapUsed,
		warmRuns: {
			count: multiNodeSamples.length,
			meanMs: round(multiNodeSamples.reduce((sum, sample) => sum + sample, 0) / multiNodeSamples.length),
			p50Ms: round(percentile(multiNodeSamples, 0.5)),
			p95Ms: round(percentile(multiNodeSamples, 0.95)),
			throughputPerSecond: round(iterations * 1000 / multiNodeElapsedMs),
			elapsedMs: round(multiNodeElapsedMs),
			rssDeltaBytesFromCatalog: afterMultiNodeWarmRuns.rss - afterCatalog.rss,
			heapUsedDeltaBytesFromCatalog: afterMultiNodeWarmRuns.heapUsed - afterCatalog.heapUsed,
		},
	},
	limitations: [`Measurements ran on Node ${process.versions.node} with locally installed official packages; the PR #6 baseline ran on Node 24.19.`, 'The workflows use one input item, deterministic local node operations and an in-memory graph engine.', 'RSS deltas are process samples, not Square Cloud steady-state measurements.'],
}, null, 2));

function percentile(values, fraction) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value) { return Math.round(value * 1000) / 1000; }
