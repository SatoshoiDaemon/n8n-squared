import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const packagesRoot = resolve(root, 'packages');
const workspacePackages = new Map();

function isWorkspaceDirectory(directory) {
	const parts = relative(root, directory).split(sep);
	if (parts[0] !== 'packages') return false;
	if (parts.length === 2) return true;
	if (parts[1] === '@n8n' && parts.length === 3) return true;
	return ['frontend', 'modules', 'extensions', 'testing'].includes(parts[1]) && parts.length >= 3;
}

function scan(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.turbo') continue;
		const absolutePath = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			scan(absolutePath);
			continue;
		}
		if (entry.name !== 'package.json' || !isWorkspaceDirectory(dirname(absolutePath))) continue;

		const manifest = JSON.parse(readFileSync(absolutePath, 'utf8'));
		if (!manifest.name || manifest.name.includes('{{')) continue;
		if (workspacePackages.has(manifest.name)) {
			throw new Error('Duplicate workspace package name: ' + manifest.name);
		}
		workspacePackages.set(manifest.name, { directory: dirname(absolutePath), manifest });
	}
}

scan(packagesRoot);

const runtimePackages = new Set();
const pending = ['n8n'];
while (pending.length > 0) {
	const name = pending.pop();
	if (runtimePackages.has(name)) continue;
	const workspace = workspacePackages.get(name);
	if (!workspace) throw new Error('Missing runtime workspace package: ' + name);

	runtimePackages.add(name);
	const dependencies = {
		...workspace.manifest.dependencies,
		...workspace.manifest.optionalDependencies,
	};
	for (const dependency of Object.keys(dependencies)) {
		if (workspacePackages.has(dependency)) pending.push(dependency);
	}
}

let dependencyEdges = 0;
const externalPackages = new Set();
for (const name of runtimePackages) {
	const workspace = workspacePackages.get(name);
	const dependencies = {
		...workspace.manifest.dependencies,
		...workspace.manifest.optionalDependencies,
	};
	for (const dependency of Object.keys(dependencies)) {
		dependencyEdges += 1;
		if (!workspacePackages.has(dependency)) externalPackages.add(dependency);
	}
}

console.log('Workspace packages: ' + workspacePackages.size);
console.log('Runtime workspace closure: ' + runtimePackages.size);
console.log('Declared dependency edges in closure: ' + dependencyEdges);
console.log('Distinct external dependency names in closure: ' + externalPackages.size);
console.log('Runtime workspace packages:');
for (const name of [...runtimePackages].sort()) {
	console.log(
		'- ' + name + ' (' + relative(root, workspacePackages.get(name).directory) + ')',
	);
}
