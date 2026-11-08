import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	createWriteStream,
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants as zlibConstants, createBrotliCompress } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
const app = join(output, 'app');
const archive = join(output, 'squared-squarecloud.zip');
const maxUploadBytes = 100_000_000;

function run(command, args, cwd = root, env = process.env) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: 'inherit',
		env,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeLock = join(root, 'package-lock.json');
if (!existsSync(runtimeLock)) throw new Error('Missing package-lock.json; run npm install first');
const runtimePackage = {
	name: product.name,
	version: product.version,
	private: true,
	type: 'module',
	main: 'src/main.js',
	engines: product.engines,
	scripts: { start: product.scripts.start },
	dependencies: product.dependencies,
};
const displayName = process.env.SQUARED_DISPLAY_NAME || 'Squared';
if (/[\r\n=]/.test(displayName)) throw new Error('Invalid SQUARED_DISPLAY_NAME');
const memory = process.env.SQUARED_MEMORY_MB || '1024';
if (!/^\d+$/.test(memory) || Number(memory) < 512) {
	throw new Error('SQUARED_MEMORY_MB must be an integer of at least 512');
}
const subdomain = process.env.SQUARED_SUBDOMAIN;
if (subdomain && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(subdomain)) {
	throw new Error('SQUARED_SUBDOMAIN must be a valid lower-case DNS label');
}

rmSync(output, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(join(root, 'src'), join(app, 'src'), { recursive: true });
removeTests(join(app, 'src'));
writeFileSync(join(app, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
copyFileSync(runtimeLock, join(app, 'package-lock.json'));
copyFileSync(join(root, 'LICENSE.md'), join(app, 'LICENSE.md'));
copyFileSync(join(root, 'UPSTREAM.md'), join(app, 'UPSTREAM.md'));
writeFileSync(
	join(app, 'squarecloud.app'),
	[
		`DISPLAY_NAME=${displayName}`,
		`MEMORY=${memory}`,
		'RUNTIME=nodejs',
		'VERSION=recommended',
		'MAIN=src/main.js',
		'START=npm start',
		...(subdomain ? [`SUBDOMAIN=${subdomain}`] : []),
		'',
	].join('\n'),
);

const n8nPackagesDirectory = resolve(process.env.SQUARED_N8N_PACKAGES_DIR || join(root, 'squared-data', 'n8n-nodes', 'node_modules'));
const n8nInstallPrefix = dirname(n8nPackagesDirectory);
const n8nPackageVersions = {
	'n8n-nodes-base': '2.42.5',
	'@n8n/n8n-nodes-langchain': '2.42.5',
	'n8n-core': '2.42.5',
	'@n8n/backend-common': '1.42.5',
	'n8n-workflow': '2.42.4',
};
for (const [name, version] of Object.entries(n8nPackageVersions)) {
	const packageManifestPath = join(n8nPackagesDirectory, ...name.split('/'), 'package.json');
	if (!existsSync(packageManifestPath)) throw new Error(`Missing installed n8n runtime package ${name}; run npm run n8n:install first`);
	const installed = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
	if (installed.version !== version) throw new Error(`Expected ${name}@${version}, found ${installed.version || 'unknown'}`);
}
const seedDirectory = join(app, 'vendor');
mkdirSync(seedDirectory, { recursive: true });
const n8nRuntimeSeed = join(seedDirectory, 'n8n-runtime.tar.br');
const seedEntries = ['package.json', 'node_modules'];
const seedCacheDirectory = join(root, 'dist', 'n8n-runtime-seed');
const seedCacheArchive = `${seedCacheDirectory}.tar.br`;
const seedCacheManifest = `${seedCacheDirectory}.json`;
const licenseCacheArchive = join(root, 'dist', 'n8n-runtime-third-party-licenses.txt');
const licenseCacheManifest = join(root, 'dist', 'n8n-runtime-third-party-licenses.json');
const licenseCacheKey = createHash('sha256')
	.update('third-party-license-bundle-v1')
	.update(JSON.stringify(n8nPackageVersions))
	.update(readFileSync(join(n8nInstallPrefix, 'package.json')))
	.update(existsSync(join(n8nInstallPrefix, 'package-lock.json')) ? readFileSync(join(n8nInstallPrefix, 'package-lock.json')) : '')
	.digest('hex');
const seedCacheKey = createHash('sha256')
	.update('brotli-text-quality-11-window-24-runtime-files-v5-license-bundle-no-ts-source')
	.update(JSON.stringify(n8nPackageVersions))
	.update(readFileSync(join(n8nInstallPrefix, 'package.json')))
	.update(existsSync(join(n8nInstallPrefix, 'package-lock.json')) ? readFileSync(join(n8nInstallPrefix, 'package-lock.json')) : '')
	.digest('hex');
let n8nRuntimeSeedSha256;
let licenseBundle;
let cachedSeed;
try {
	cachedSeed = JSON.parse(readFileSync(seedCacheManifest, 'utf8'));
} catch {
	// Build the seed from the installed package tree when no complete cache exists.
}
if (cachedSeed?.key === seedCacheKey && cachedSeed.licenseBundle && existsSync(seedCacheArchive)) {
	const cachedHash = createHash('sha256').update(readFileSync(seedCacheArchive)).digest('hex');
	if (cachedHash === cachedSeed.sha256) {
		copyFileSync(seedCacheArchive, n8nRuntimeSeed);
		n8nRuntimeSeedSha256 = cachedHash;
		licenseBundle = cachedSeed.licenseBundle;
	}
}
if (!n8nRuntimeSeedSha256) {
	const licensePath = join(seedDirectory, 'THIRD_PARTY_LICENSES.txt');
	let cachedLicenses;
	try {
		cachedLicenses = JSON.parse(readFileSync(licenseCacheManifest, 'utf8'));
	} catch {
		// Regenerate the license bundle when no complete cache exists.
	}
	if (cachedLicenses?.key === licenseCacheKey && existsSync(licenseCacheArchive)) {
		const cachedLicenseHash = createHash('sha256').update(readFileSync(licenseCacheArchive)).digest('hex');
		if (cachedLicenseHash === cachedLicenses.licenseBundle?.sha256) {
			copyFileSync(licenseCacheArchive, licensePath);
			licenseBundle = cachedLicenses.licenseBundle;
		}
	}
	if (!licenseBundle) {
		licenseBundle = createThirdPartyLicenseBundle(n8nPackagesDirectory, licensePath);
		copyFileSync(licensePath, licenseCacheArchive);
		writeFileSync(licenseCacheManifest, `${JSON.stringify({ key: licenseCacheKey, licenseBundle }, null, 2)}\n`);
	}
	await createBrotliTarSeed(n8nInstallPrefix, n8nRuntimeSeed, seedEntries, seedDirectory);
	rmSync(join(seedDirectory, 'THIRD_PARTY_LICENSES.txt'), { force: true });
	n8nRuntimeSeedSha256 = createHash('sha256').update(readFileSync(n8nRuntimeSeed)).digest('hex');
	mkdirSync(join(root, 'dist'), { recursive: true });
	copyFileSync(n8nRuntimeSeed, seedCacheArchive);
	writeFileSync(seedCacheManifest, `${JSON.stringify({ key: seedCacheKey, sha256: n8nRuntimeSeedSha256, licenseBundle }, null, 2)}\n`);
}

// The deploy ZIP is a conventional Node app. It has no workspace install or build step.
run('npm', ['ci', '--omit=dev', '--ignore-scripts'], app);
const archiveEntries = normalizeArchiveMetadata(app);
const normalizedEntries = archiveEntries.map((entry) => entry.split(sep).join('/'));
if (hasExecutable('zip')) {
	run('zip', ['-q', '-X', archive, ...normalizedEntries], app, { ...process.env, TZ: 'UTC' });
} else if (process.platform === 'win32' && hasExecutable('tar')) {
	run('tar', ['-a', '-c', '-f', archive, ...normalizedEntries], app);
} else {
	throw new Error('ZIP creation requires zip; Windows also supports the built-in tar command');
}
validateArchive(archive);
const bytes = statSync(archive).size;
if (bytes > maxUploadBytes) throw new Error(`Square Cloud upload limit exceeded: ${bytes} > ${maxUploadBytes} bytes`);

const manifest = {
	product: product.name,
	version: product.version,
	archive: 'squared-squarecloud.zip',
	bytes,
	sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
	entrypoint: 'src/main.js',
	startCommand: 'npm start',
	buildRequired: false,
	workspacePackages: 0,
	dependencies: product.dependencies,
	n8nRuntime: {
		packages: n8nPackageVersions,
		seedArchive: 'vendor/n8n-runtime.tar.br',
		seedBytes: statSync(n8nRuntimeSeed).size,
		seedSha256: n8nRuntimeSeedSha256,
		licenseBundle,
	},
	historicalSource: 'n8n source snapshot; see UPSTREAM.md',
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));

function removeTests(directory) {
	for (const name of readdirSync(directory)) {
		const entry = join(directory, name);
		if (statSync(entry).isDirectory()) removeTests(entry);
		else if (/\.(test|spec)\.js$/.test(name)) rmSync(entry);
	}
}

function createThirdPartyLicenseBundle(nodeModulesDirectory, target) {
	const sections = ['Third-party license and notice files bundled with the official n8n runtime packages.\n'];
	const licensePattern = /^(?:license|licence|copying|notice|copyright)(?:[._-].*)?$/i;
	let files = 0;
	function visit(directory) {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const entry = lstatSync(path);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) visit(path);
			else if (licensePattern.test(name)) {
				const relative = path.slice(nodeModulesDirectory.length + 1).split(sep).join('/');
				sections.push(`\n\n===== ${relative} =====\n\n`);
				sections.push(readFileSync(path));
				files += 1;
			}
		}
	}
	visit(nodeModulesDirectory);
	const contents = Buffer.concat(sections.map((section) => Buffer.isBuffer(section) ? section : Buffer.from(section)));
	writeFileSync(target, contents);
	return {
		file: 'THIRD_PARTY_LICENSES.txt',
		files,
		bytes: contents.length,
		sha256: createHash('sha256').update(contents).digest('hex'),
	};
}

async function createBrotliTarSeed(sourceDirectory, target, entries, licenseBundleDirectory) {
	const args = [
		'-c', '-f', '-',
		'--exclude=*.map', '--exclude=*.d.ts', '--exclude=*.test.js', '--exclude=*.spec.js', '--exclude=*.test.ts', '--exclude=*.spec.ts',
		'--exclude=README*', '--exclude=readme*', '--exclude=CHANGELOG*', '--exclude=CHANGES*', '--exclude=*.mdx',
		'--exclude=*.md', '--exclude=*.MD', '--exclude=*.markdown', '--exclude=*.MARKDOWN', '--exclude=*.rst', '--exclude=*.RST',
		'--exclude=*.ts', '--exclude=*.tsx', '--exclude=*.cts', '--exclude=*.mts', '--exclude=*.d.cts', '--exclude=*.d.mts',
		'--exclude=docs', '--exclude=examples', '--exclude=example', '--exclude=test', '--exclude=tests', '--exclude=__tests__', '--exclude=coverage',
		'-C', sourceDirectory,
		...entries,
		'-C', licenseBundleDirectory, 'THIRD_PARTY_LICENSES.txt',
	];
	const child = spawn('tar', args, {
		cwd: sourceDirectory,
		stdio: ['ignore', 'pipe', 'inherit'],
		windowsHide: true,
	});
	const closed = once(child, 'close');
	try {
		await pipeline(
			child.stdout,
		createBrotliCompress({
			params: {
				[zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
				[zlibConstants.BROTLI_PARAM_QUALITY]: 11,
				[zlibConstants.BROTLI_PARAM_LGWIN]: 24,
			},
		}),
			createWriteStream(target),
		);
		const [code] = await closed;
		if (code !== 0) throw new Error(`tar exited with ${code ?? 'unknown status'}`);
	} catch (error) {
		child.kill();
		throw error instanceof Error ? error : new Error('Could not create the packaged n8n runtime seed');
	}
}

function hasExecutable(command) {
	return !spawnSync(command, ['--version'], { stdio: 'ignore' }).error;
}

function validateArchive(path) {
	if (hasExecutable('unzip')) run('unzip', ['-tqq', path]);
	else if (process.platform === 'win32' && hasExecutable('tar')) run('tar', ['-tf', path]);
	else throw new Error('ZIP validation requires unzip; Windows also supports the built-in tar command');
}

function normalizeArchiveMetadata(directory) {
	const fixedTime = new Date('2000-01-01T00:00:00.000Z');
	const entries = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		const entry = lstatSync(path);
		if (entry.isSymbolicLink()) {
			lutimesSync(path, fixedTime, fixedTime);
			entries.push(name);
		} else if (entry.isDirectory()) {
			chmodSync(path, 0o755);
			utimesSync(path, fixedTime, fixedTime);
			entries.push(...normalizeArchiveMetadata(path).map((child) => join(name, child)));
		} else {
			chmodSync(path, 0o644);
			utimesSync(path, fixedTime, fixedTime);
			entries.push(name);
		}
	}
	return entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}
