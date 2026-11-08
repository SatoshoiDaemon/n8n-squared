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
	limitations: ['Single Node 24.19 process sample, one-item Set v3.5 workflow and external installed package.', 'RSS deltas are process samples, not Square Cloud steady-state measurements.'],
}, null, 2));

function percentile(values, fraction) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value) { return Math.round(value * 1000) / 1000; }
