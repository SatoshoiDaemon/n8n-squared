import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	cpSync,
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
const memory = process.env.SQUARED_MEMORY_MB || '3072';
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
const n8nRuntimeLockPath = join(n8nInstallPrefix, 'package-lock.json');
if (!existsSync(n8nRuntimeLockPath)) throw new Error('Missing n8n runtime package-lock.json; run npm run n8n:install first');
const n8nRuntimeLock = JSON.parse(readFileSync(n8nRuntimeLockPath, 'utf8'));
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
	if (n8nRuntimeLock.packages?.[`node_modules/${name}`]?.version !== version) {
		throw new Error(`n8n runtime package-lock.json does not pin ${name}@${version}`);
	}
}
const n8nRuntimeLockCopy = 'vendor/n8n-package-lock.json';
mkdirSync(join(app, 'vendor'), { recursive: true });
copyFileSync(n8nRuntimeLockPath, join(app, n8nRuntimeLockCopy));
const n8nRuntimeLockSha256 = createHash('sha256').update(readFileSync(n8nRuntimeLockPath)).digest('hex');

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
	memoryMb: Number(memory),
	dependencies: product.dependencies,
	n8nRuntime: {
		packages: n8nPackageVersions,
		installMode: 'npm ci on first start into persistent application storage',
		persistentDirectory: 'n8n-nodes/node_modules',
		lockfile: n8nRuntimeLockCopy,
		lockfileSha256: n8nRuntimeLockSha256,
		publishedPackageLicenses: 'retained in the installed official npm packages',
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
