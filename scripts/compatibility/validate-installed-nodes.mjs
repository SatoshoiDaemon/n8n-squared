import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadN8nPackageNodeStates, runN8nBaseCompatibilityProbe } from '../../src/nodes/n8n/compatibility-probe.mjs';

const packagesDirectory = process.env.SQUARED_N8N_PACKAGES_DIR;
if (!packagesDirectory) {
	throw new Error('Set SQUARED_N8N_PACKAGES_DIR to the node_modules directory containing n8n-nodes-base and its dependencies.');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const probe = await runN8nBaseCompatibilityProbe(packagesDirectory);
const loadState = await loadN8nPackageNodeStates(packagesDirectory);
const executionEvidence = new Map(probe.nodes.map((node) => [node.nodeType, node]));
const runtimeNodes = loadState.nodes.map((node) => {
	const validation = executionEvidence.get(node.nodeType);
	const capability = loadState.capabilities[node.nodeType];
	const validationCompatibility = validation?.compatibility ?? {};
	const compatibility = Object.fromEntries(['discovered', 'loaded', 'configurable', 'executable', 'validated']
		.map((stage) => [stage, Boolean(node.compatibility[stage] || validationCompatibility[stage])]));
	const staleValidationFailures = new Set([
		'Node code is discovered but has not been loaded into the runtime.',
		'No successful node execution has exercised this node version against Squared contracts yet.',
		'Static node metadata has no parameter properties array.',
		'Node description has no properties array.',
	]);
	return {
		package: node.packageName,
		packageVersion: node.packageVersion,
		node: node.nodeType,
		manifestPath: node.manifestPath.replaceAll('\\', '/'),
		version: capability?.version ?? node.version,
		supportedVersions: node.version,
		interfacesUsed: [...new Set([...node.interfacesUsed, ...(validation?.interfacesUsed ?? [])])].sort(),
		capabilities: capability,
		compatibility,
		validationEvidence: validation?.validationEvidence ?? [],
		knownFailures: [...new Set([
			...node.knownFailures,
			...(validation?.knownFailures ?? []).filter((failure) => !staleValidationFailures.has(failure)),
		])],
	};
});
const report = {
	package: 'n8n-nodes-base',
	packageVersion: probe.nodes.find((node) => node.packageName === 'n8n-nodes-base')?.packageVersion ?? 'unknown',
	packages: loadState.packages,
	packageSource: 'installed npm package loaded from SQUARED_N8N_PACKAGES_DIR',
	nodesDiscovered: loadState.nodesDiscovered,
	nodeTypesLoaded: runtimeNodes.filter((node) => node.compatibility.loaded).length,
	nodeTypesConfigurable: runtimeNodes.filter((node) => node.compatibility.configurable).length,
	nodeTypesExecutable: runtimeNodes.filter((node) => node.compatibility.executable).length,
	nodeTypesValidated: runtimeNodes.filter((node) => node.compatibility.validated).length,
	deterministicExecutions: probe.executions.length,
	differentialAgainstN8n: false,
	nodes: runtimeNodes,
	credentials: probe.credentials.filter((credential) => credential.loaded).map((credential) => ({
		package: credential.packageName,
		packageVersion: credential.packageVersion,
		credentialType: credential.credentialType,
		loaded: credential.loaded,
		configurable: credential.configurable,
		knownFailures: credential.knownFailures,
	})),
};
const output = join(root, 'docs/squared/compatibility-runtime-results.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Loaded ${report.nodeTypesLoaded}/${report.nodesDiscovered} node classes and validated ${report.nodeTypesValidated} node types in ${report.deterministicExecutions} executions against ${report.package}@${report.packageVersion}.`);
