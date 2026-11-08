import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runN8nBaseCompatibilityProbe } from '../../src/nodes/n8n/compatibility-probe.mjs';

const packagesDirectory = process.env.SQUARED_N8N_PACKAGES_DIR;
if (!packagesDirectory) {
	throw new Error('Set SQUARED_N8N_PACKAGES_DIR to the node_modules directory containing n8n-nodes-base and its dependencies.');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const probe = await runN8nBaseCompatibilityProbe(packagesDirectory);
const validatedTypes = new Set(probe.executions.map((execution) => execution.nodeType));
const report = {
	package: 'n8n-nodes-base',
	packageVersion: probe.nodes.find((node) => node.packageName === 'n8n-nodes-base')?.packageVersion ?? 'unknown',
	packageSource: 'installed npm package loaded from SQUARED_N8N_PACKAGES_DIR',
	nodesDiscovered: probe.nodesDiscovered,
	deterministicExecutions: probe.executions.length,
	differentialAgainstN8n: false,
	nodes: probe.nodes.filter((node) => validatedTypes.has(node.nodeType)).map((node) => ({
		package: node.packageName,
		packageVersion: node.packageVersion,
		node: node.nodeType,
		version: node.version,
		interfacesUsed: node.interfacesUsed,
		compatibility: node.compatibility,
		validationEvidence: node.validationEvidence ?? [],
		knownFailures: node.knownFailures,
	})),
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
console.log(`Validated ${report.nodes.length} node types in ${report.deterministicExecutions} executions against ${report.package}@${report.packageVersion}.`);
