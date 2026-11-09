import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadN8nPackageNodeStates, runN8nBaseCompatibilityProbe } from '../../src/nodes/n8n/compatibility-probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const referencePackages = [
	{ packageName: 'n8n-nodes-base', sourceRoot: 'packages/nodes-base' },
	{ packageName: '@n8n/n8n-nodes-langchain', sourceRoot: 'packages/@n8n/nodes-langchain' },
];
const outputJson = join(root, 'docs/squared/compatibility-matrix.json');
const outputSummary = join(root, 'docs/squared/compatibility-matrix.md');
const runtimeEvidencePath = join(root, 'docs/squared/compatibility-runtime-results.json');
const knownFailures = [
	'The package is not bundled with Squared; configure SQUARED_N8N_PACKAGES_DIR and install the package with its declared dependencies.',
	'No successful execution has yet exercised this node version against Squared contracts.',
	'No differential execution result against an authenticated n8n reference instance is available.',
];
const reuseRuntimeEvidence = process.argv.includes('--reuse-runtime-evidence');

const records = [];
const credentialPackages = [];
const sourceCache = new Map();
for (const reference of referencePackages) {
	const packageRoot = join(root, reference.sourceRoot);
	const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
	const n8n = manifest.n8n ?? {};
	credentialPackages.push({ package: reference.packageName, packageVersion: manifest.version, discoveredCredentials: (n8n.credentials ?? []).length });
	for (const distributionPath of n8n.nodes ?? []) {
		const sourcePath = distributionPath.replace(/^dist\//, '').replace(/\.node\.ee\.js$/i, '.node.ee.ts').replace(/\.node\.js$/i, '.node.ts');
		const absoluteSource = join(packageRoot, sourcePath);
		const source = await readSource(absoluteSource);
		const metadataSource = await readSourceClosure(absoluteSource, packageRoot, sourceCache);
		const declaredNodeName = findNodeType(source) ?? findNodeType(metadataSource) ?? basename(sourcePath).replace(/\.node\.ts$/i, '');
		const nodeType = declaredNodeName.includes('.') ? declaredNodeName : `${reference.packageName}.${lowerFirst(declaredNodeName)}`;
		const interfacesUsed = [...new Set(metadataSource.match(/\bI(?:Execute|ExecuteSingle|SupplyData|Trigger|Poll|Webhook|Hook|LoadOptions|NodeExecutionData|NodeType|CredentialType|WorkflowNodeContext|NodeTypeDescription)\w*\b/g) ?? [])].sort();
		const entryImports = declaredDependencyImports(source, manifest, reference.packageName);
		const sourceClosureDependencies = declaredDependencyImports(metadataSource, manifest, reference.packageName);
		const executionTypes = classifyExecution(source);
		const enterpriseRestricted = /\.ee\./i.test(distributionPath);
		records.push({
			package: reference.packageName,
			packageVersion: manifest.version,
			license: enterpriseRestricted ? 'LicenseRef-n8n-enterprise' : manifest.license,
			node: nodeType,
			sourceFile: relative(root, absoluteSource).replaceAll('\\', '/'),
			typeVersion: findNodeVersion(metadataSource),
			executionType: executionTypes.length ? executionTypes : ['unknown'],
			dependenciesDetectedInSourceClosure: sourceClosureDependencies,
			importsDetectedInEntryFile: entryImports,
			interfacesUsed,
			compatibility: { discovered: true, loaded: false, configurable: false, executable: false, validated: false },
			knownFailures: [
				...(enterpriseRestricted ? ['This .ee. node is covered by the n8n Enterprise license and is excluded from Squared distribution.'] : []),
				...(source ? [] : ['Node source file is missing from the historical source tree.']),
				...knownFailures,
			],
		});
	}
}

let runtimeEvidence = await readFile(runtimeEvidencePath, 'utf8').then(JSON.parse).catch(() => null);
if (reuseRuntimeEvidence) {
	if (!process.env.SQUARED_N8N_PACKAGES_DIR) throw new Error('--reuse-runtime-evidence requires SQUARED_N8N_PACKAGES_DIR to verify the installed package versions.');
	if (!runtimeEvidence?.packages?.length) throw new Error('No runtime compatibility evidence is available to reuse; run npm run compatibility:validate first.');
	for (const packageVersion of runtimeEvidence.packages) {
		const separator = packageVersion.lastIndexOf('@');
		if (separator <= 0 || separator === packageVersion.length - 1) throw new Error(`Runtime compatibility evidence has an invalid package version entry: ${packageVersion}.`);
		const packageName = packageVersion.slice(0, separator);
		const expectedVersion = packageVersion.slice(separator + 1);
		const evidenceVersion = runtimeEvidence.nodes.find((node) => node.package === packageName)?.packageVersion;
		if (evidenceVersion !== expectedVersion) throw new Error(`Runtime compatibility evidence has no matching version for ${packageName}.`);
		const manifestPath = join(process.env.SQUARED_N8N_PACKAGES_DIR, ...packageName.split('/'), 'package.json');
		const installed = JSON.parse(await readFile(manifestPath, 'utf8'));
		if (installed.version !== expectedVersion) throw new Error(`Runtime evidence package mismatch for ${packageName}: expected ${expectedVersion}, found ${installed.version}.`);
	}
}
if (process.env.SQUARED_N8N_PACKAGES_DIR && !reuseRuntimeEvidence) {
	const probe = await runN8nBaseCompatibilityProbe(process.env.SQUARED_N8N_PACKAGES_DIR);
	const loadState = await loadN8nPackageNodeStates(process.env.SQUARED_N8N_PACKAGES_DIR);
	const executionEvidence = new Map(probe.nodes.map((node) => [node.nodeType, node]));
	const loadedNodes = loadState.nodes.map((node) => {
		const validation = executionEvidence.get(node.nodeType);
		const capability = loadState.capabilities[node.nodeType];
		const validationCompatibility = validation?.compatibility ?? {};
		const compatibility = Object.fromEntries(['discovered', 'loaded', 'configurable', 'executable', 'validated']
			.map((stage) => [stage, Boolean(node.compatibility[stage] || validationCompatibility[stage])]));
		const staleValidationFailures = new Set([
			'Node code is discovered but has not been loaded into the runtime.',
			'Generated node description JSON is missing or unreadable.',
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
	runtimeEvidence = {
		package: 'n8n-nodes-base',
		packageVersion: probe.nodes.find((node) => node.packageName === 'n8n-nodes-base')?.packageVersion ?? 'unknown',
		packages: [...new Map(loadState.nodes.map((node) => [node.packageName, node.packageVersion])).entries()].map(([name, version]) => `${name}@${version}`),
		packageSource: 'installed npm package loaded from SQUARED_N8N_PACKAGES_DIR',
		nodesDiscovered: loadState.nodesDiscovered,
		nodesLoaded: loadedNodes.filter((node) => node.compatibility.loaded).length,
		nodesConfigurable: loadedNodes.filter((node) => node.compatibility.configurable).length,
		nodesExecutable: loadedNodes.filter((node) => node.compatibility.executable).length,
		nodesValidated: loadedNodes.filter((node) => node.compatibility.validated).length,
		deterministicExecutions: probe.executions.length,
		differentialAgainstN8n: false,
		nodes: loadedNodes,
		credentials: probe.credentials.filter((credential) => credential.loaded).map((credential) => ({
			package: credential.packageName,
			packageVersion: credential.packageVersion,
			credentialType: credential.credentialType,
			loaded: credential.loaded,
			configurable: credential.configurable,
			knownFailures: credential.knownFailures,
		})),
	};
	await writeFile(runtimeEvidencePath, `${JSON.stringify(runtimeEvidence, null, 2)}\n`);
}
const runtimeNodes = new Map((runtimeEvidence?.nodes ?? []).filter((node) => node.manifestPath).map((node) => [runtimeSourceKey(node.manifestPath), node]));
for (const record of records) {
	const runtimeNode = runtimeNodes.get(staticSourceKey(record.sourceFile));
	if (!runtimeNode) continue;
	record.runtimeType = runtimeNode.node;
	record.runtimePackage = runtimeNode.package;
	record.runtimePackageVersion = runtimeNode.packageVersion;
	record.runtimeVersion = runtimeNode.version;
	record.supportedVersions = runtimeNode.supportedVersions;
	record.runtimeCapabilities = runtimeNode.capabilities;
	record.interfacesUsed = [...new Set([...record.interfacesUsed, ...runtimeNode.interfacesUsed])].sort();
	record.compatibility = Object.fromEntries(['discovered', 'loaded', 'configurable', 'executable', 'validated']
		.map((stage) => [stage, Boolean(record.compatibility[stage] || runtimeNode.compatibility[stage])]));
	record.validationEvidence = runtimeNode.validationEvidence;
	record.knownFailures = record.knownFailures.filter((failure) => !knownFailures.includes(failure));
	record.knownFailures.push(...runtimeNode.knownFailures.filter((failure) => !record.knownFailures.includes(failure)));
}
records.sort((left, right) => `${left.package}:${left.node}`.localeCompare(`${right.package}:${right.node}`));
const stages = ['discovered', 'loaded', 'configurable', 'executable', 'validated'];
const summary = {
	referenceSource: 'UPSTREAM.md: n8n@2.42.7; package manifests in the snapshot are not all the same patch version.',
	referencePackages: referencePackages.map(({ packageName, sourceRoot }) => {
		const manifest = JSON.parse(readFileSync(join(root, sourceRoot, 'package.json'), 'utf8'));
		return { package: packageName, version: manifest.version, nodesDiscovered: (manifest.n8n?.nodes ?? []).length };
	}),
	credentialPackages,
		packageDependencies: referencePackages.map(({ packageName, sourceRoot }) => {
			const manifest = JSON.parse(readFileSync(join(root, sourceRoot, 'package.json'), 'utf8'));
			return {
				package: packageName,
				dependenciesDeclaredByManifest: Object.keys(manifest.dependencies ?? {}).sort(),
				peerDependenciesDeclaredByManifest: Object.keys(manifest.peerDependencies ?? {}).sort(),
			};
		}),
	communityPackages: { discovered: 0, limitation: 'No community package list is available from the configured reference instance.' },
	runtimeValidation: runtimeEvidence ? {
		package: runtimeEvidence.package,
		packageVersion: runtimeEvidence.packageVersion,
		packages: runtimeEvidence.packages,
		nodesDiscovered: runtimeEvidence.nodesDiscovered,
		deterministicExecutions: runtimeEvidence.deterministicExecutions,
		nodesValidated: runtimeEvidence.nodes.filter((node) => node.compatibility.validated).length,
		nodesLoaded: runtimeEvidence.nodes.filter((node) => node.compatibility.loaded).length,
		nodesConfigurable: runtimeEvidence.nodes.filter((node) => node.compatibility.configurable).length,
		nodesExecutable: runtimeEvidence.nodes.filter((node) => node.compatibility.executable).length,
		credentialSchemasLoaded: runtimeEvidence.credentials?.filter((credential) => credential.loaded).length ?? 0,
		credentialSchemasConfigurable: runtimeEvidence.credentials?.filter((credential) => credential.configurable).length ?? 0,
		differentialAgainstN8n: runtimeEvidence.differentialAgainstN8n,
		evidenceFile: 'docs/squared/compatibility-runtime-results.json',
	} : null,
	nodeCount: records.length,
	stageCounts: Object.fromEntries(stages.map((stage) => [stage, records.filter((record) => record.compatibility[stage]).length])),
	fullyValidatedNodes: records.filter((record) => record.compatibility.validated).length,
	knownLimitations: [
		'Executable means an adapter can dispatch to a supported published lifecycle; validated means at least one deterministic operation completed successfully.',
		'Nodes execute actual installed package code, but n8n packages remain external and must be installed with their compatible dependencies.',
		'No differential execution against the configured live reference was possible because its URL served Squared and exposed no authenticated n8n API.',
		'Community node package discovery requires an installed package directory; no reference-instance community package list was available.',
	],
};

await mkdir(dirname(outputJson), { recursive: true });
await writeFile(outputJson, `${JSON.stringify({ summary, nodes: records }, null, 2)}\n`);
await writeFile(outputSummary, renderSummary(summary, credentialPackages));
	console.log(`Generated ${records.length} node records. Stages: ${stages.map((stage) => `${stage}=${summary.stageCounts[stage]}`).join(', ')}.`);

function renderSummary(matrix, credentials) {
	const packageLines = matrix.referencePackages.map((item) => `| \`${item.package}\` | ${item.version} | ${item.nodesDiscovered} |`).join('\n');
	const credentialLines = credentials.map((item) => `| \`${item.package}\` | ${item.packageVersion} | ${item.discoveredCredentials} |`).join('\n');
	const stageLines = stages.map((stage) => `| ${stage} | ${matrix.stageCounts[stage]} / ${matrix.nodeCount} |`).join('\n');
	const credentialSchemaLabel = matrix.runtimeValidation?.credentialSchemasLoaded === 1 ? '1 schema de credencial' : `${matrix.runtimeValidation?.credentialSchemasLoaded ?? 0} schemas de credencial`;
	const runtimePackageLabel = matrix.runtimeValidation?.packages?.join(', ') ?? `n8n-nodes-base@${matrix.runtimeValidation?.packageVersion ?? 'unknown'}`;
	return `# Matriz de compatibilidade de nodes\n\n` +
		`Gerada a partir da árvore histórica indicada em [UPSTREAM.md](../../UPSTREAM.md), com evidência de execução de módulos npm reais quando disponível. O snapshot registra n8n 2.42.7, mas os manifests dos pacotes abaixo têm versões próprias.\n\n` +
		`## Pacotes de referência\n\n| Pacote | Versão do manifest | Nodes descobertos |\n| --- | ---: | ---: |\n${packageLines}\n\n` +
		`| Pacote | Versão do manifest | Credenciais descobertas |\n| --- | ---: | ---: |\n${credentialLines}\n\n` +
		`## Etapas\n\n| Estado | Cobertura |\n| --- | ---: |\n${stageLines}\n\n` +
		`Estados: descoberto vem dos manifests; carregado exige importar a classe publicada; configurável exige uma descrição com propriedades; executável exige um adapter de lifecycle que o runtime consiga resolver; validado exige ao menos um cenário real concluído. Um cenário valida apenas a versão e a operação registradas. O JSON também registra dependências, interfaces, licença, capabilities e falhas por node.\n\n` +
		`${matrix.runtimeValidation ? `A validação carregou ${matrix.runtimeValidation.nodesLoaded}/${matrix.runtimeValidation.nodesDiscovered} classes e executou ${matrix.runtimeValidation.deterministicExecutions} casos determinísticos com ${runtimePackageLabel}; ${matrix.runtimeValidation.nodesValidated} tipos passaram cenários reais e ${credentialSchemaLabel} foram carregados. Os resultados não são uma comparação diferencial com uma instância n8n. Veja [compatibility-runtime-results.json](./compatibility-runtime-results.json).` : 'Ainda não há evidência de execução do pacote instalado. Defina SQUARED_N8N_PACKAGES_DIR e execute npm run compatibility:validate.'} Community packages descobertos na referência: não disponíveis.\n`;
}

function findNodeType(source) {
	const classDescriptionName = source.match(/\bexport\s+class\s+\w+[\s\S]{0,5000}?\bdescription\s*(?::\s*[^=]+)?=\s*\{[\s\S]{0,2000}?\bname\s*:\s*['"]([^'"]+)['"]/m)?.[1];
	const descriptionName = source.match(/\b(?:base)?description\s*(?::\s*[^=]+)?=\s*\{\s*displayName\s*:\s*['"][^'"]+['"][\s\S]{0,500}?\bname\s*:\s*['"]([^'"]+)['"]/im)?.[1];
	const exportedClassName = source.match(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/)?.[1];
	return classDescriptionName ?? descriptionName ?? exportedClassName ?? source.match(/\bname\s*:\s*['"](n8n-nodes-[^'"]+)['"]/m)?.[1] ?? null;
}

function findNodeVersion(source) {
	const match = source.match(/\b(?:defaultVersion|version)\s*:\s*(\[[^\]]+\]|[\d.]+)/m);
	if (!match) return null;
	const value = match[1] ?? '';
	if (value.startsWith('[')) {
		const versions = [...value.matchAll(/[\d.]+/g)].map((item) => Number(item[0])).filter(Number.isFinite);
		return versions.length ? versions : null;
	}
	const version = Number(value);
	return Number.isFinite(version) ? version : null;
}

function classifyExecution(source) {
	const types = [];
	if (/\bexecute\s*\(/.test(source)) types.push('execute');
	if (/\btrigger\s*\(/.test(source)) types.push('trigger');
	if (/\bpoll\s*\(/.test(source)) types.push('poll');
	if (/\bwebhook\s*\(/.test(source)) types.push('webhook');
	if (/\bsupplyData\s*\(/.test(source)) types.push('supplyData');
	if (/requestDefaults|requestOperations/.test(source)) types.push('declarative');
	if (/customOperations/.test(source)) types.push('customOperations');
	return types;
}

function lowerFirst(value) { return value ? value[0].toLowerCase() + value.slice(1) : value; }

function packageSpecifier(specifier) {
	if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:')) return null;
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function declaredDependencyImports(source, manifest, packageName) {
	const declared = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);
	const imports = [
		...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
		...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
	];
	return [...new Set(imports.map((match) => packageSpecifier(match[1] ?? '')))]
		.filter((specifier) => specifier && specifier !== packageName && declared.has(specifier))
		.sort();
}

function basename(path) {
	return path.split(/[\\/]/).at(-1) ?? path;
}

function staticSourceKey(sourceFile) {
	return sourceFile.replaceAll('\\', '/').replace(/^packages\/(?:nodes-base|@n8n\/nodes-langchain)\//, '');
}

function runtimeSourceKey(manifestPath) {
	const normalized = manifestPath.replaceAll('\\', '/');
	const distIndex = normalized.indexOf('/dist/');
	if (distIndex < 0) return normalized;
	return normalized.slice(distIndex + '/dist/'.length).replace(/\.node\.js$/i, '.node.ts');
}
async function readSourceClosure(entryFile, packageRoot, cache) {
	const visited = new Set();
	const queue = [entryFile];
	const blocks = [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current)) continue;
		visited.add(current);
		if (!/\.(?:ts|js)$/i.test(current) || /\.(?:test|spec)\.(?:ts|js)$/i.test(current)) continue;
		const content = await readSource(current, cache);
		if (!content) continue;
		blocks.push(content);
		for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\()(['"])(\.[^'"]+)\1/g)) {
			const specifier = match[2];
			if (!specifier || /\.(?:test|spec)$/.test(specifier)) continue;
			const target = await resolveSourceImport(dirname(current), specifier, packageRoot, cache);
			if (target) queue.push(target);
		}
	}
	return blocks.join('\n');
}

async function resolveSourceImport(directory, specifier, packageRoot, cache) {
	const base = resolve(directory, specifier);
	const fromRoot = relative(packageRoot, base);
	if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(packageRoot) === base) return null;
	const candidates = /\.[a-z]+$/i.test(base)
		? [base]
		: [`${base}.ts`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js')];
	for (const candidate of candidates) {
		if (await readSource(candidate, cache)) return candidate;
	}
	return null;
}

async function readSource(path, cache = sourceCache) {
	if (cache.has(path)) return cache.get(path) ?? '';
	const content = await readFile(path, 'utf8').catch(() => null);
	cache.set(path, content);
	return content ?? '';
}
