import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const referencePackages = [
	{ packageName: 'n8n-nodes-base', sourceRoot: 'packages/nodes-base' },
	{ packageName: '@n8n/n8n-nodes-langchain', sourceRoot: 'packages/@n8n/nodes-langchain' },
];
const outputJson = join(root, 'docs/squared/compatibility-matrix.json');
const outputSummary = join(root, 'docs/squared/compatibility-matrix.md');
const knownFailures = [
	'The package is present as historical source only; it is not installed in the Squared runtime.',
	'Squared does not import node implementation code or provide the complete n8n execution-context/helper contracts.',
	'No differential execution result against an authenticated n8n reference instance is available.',
];

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
		const declaredNodeName = findNodeType(metadataSource) ?? basename(sourcePath).replace(/\.node\.ts$/i, '');
		const nodeType = declaredNodeName.includes('.') ? declaredNodeName : `${reference.packageName}.${declaredNodeName}`;
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
	nodeCount: records.length,
	stageCounts: Object.fromEntries(stages.map((stage) => [stage, records.filter((record) => record.compatibility[stage]).length])),
	fullyValidatedNodes: records.filter((record) => record.compatibility.validated).length,
	knownLimitations: [
		'Historical source manifests identify package files but do not prove an installed n8n version or load generated JSON descriptions.',
		'Node implementation modules are intentionally not imported or executed by this generator.',
		'Executable and differential validation stages remain false until an isolated execution adapter and reference instance are available.',
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
	return `# Matriz de compatibilidade de nodes\n\n` +
		`Gerada a partir da árvore histórica indicada em [UPSTREAM.md](../../UPSTREAM.md). O snapshot registra n8n 2.42.7, mas os manifests dos pacotes abaixo têm versões próprias. A URL configurada para a instalação de referência responde como Squared 0.1.0 e não permite validar uma instalação n8n.\n\n` +
		`## Pacotes de referência\n\n| Pacote | Versão do manifest | Nodes descobertos |\n| --- | ---: | ---: |\n${packageLines}\n\n` +
		`| Pacote | Versão do manifest | Credenciais descobertas |\n| --- | ---: | ---: |\n${credentialLines}\n\n` +
		`## Etapas\n\n| Estado | Cobertura |\n| --- | ---: |\n${stageLines}\n\n` +
		`O JSON ao lado contém um registro por entrada de node nos manifests, com tipo de execução inferido estaticamente, versão encontrada no source, dependências externas detectadas na closure local do source, imports diretos do arquivo de entrada, interfaces reconhecidas, licença declarada e falhas conhecidas. As dependências declaradas no manifest aparecem uma vez por pacote no resumo. A inferência estática não conta como carregamento ou teste.\n\n` +
		`Não há nodes carregados, configuráveis, executáveis ou validados nesta matriz. O catálogo externo ainda não está instalado no runtime e o código dos nodes não é importado pelo processo Squared. Isso evita marcar nomes/metadados como compatibilidade executável. Community packages: não descobertos; a instância de referência não disponibiliza sua lista autenticada.\n`;
}

function findNodeType(source) {
	const descriptionName = source.match(/displayName\s*:\s*['"][^'"]+['"][\s\S]{0,500}?\bname\s*:\s*['"]([^'"]+)['"]/m)?.[1];
	return descriptionName ?? source.match(/\bname\s*:\s*['"](n8n-nodes-[^'"]+)['"]/m)?.[1] ?? null;
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
	if (/requestDefaults|requestOperations/.test(source)) types.push('declarative');
	if (/customOperations/.test(source)) types.push('customOperations');
	return types;
}

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
