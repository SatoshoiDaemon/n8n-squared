import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function verifySquareCloudPackage() {
	const root = resolve(import.meta.dirname, '../..');
	const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
	const archive = resolve(output, 'squared-squarecloud.zip');
	const manifestPath = resolve(output, 'manifest.json');
	if (!existsSync(archive) || !existsSync(manifestPath)) {
		throw new Error('Square Cloud package is incomplete; run npm run package:squarecloud first');
	}

	function run(command, args) {
		const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${command} failed while verifying the Square Cloud ZIP`);
		return result.stdout;
	}
	function hasExecutable(command) {
		return !spawnSync(command, ['--version'], { stdio: 'ignore' }).error;
	}
	function archiveOutput(unzipArgs, tarArgs) {
		if (hasExecutable('unzip')) return run('unzip', unzipArgs);
		if (process.platform === 'win32' && hasExecutable('tar')) return run('tar', tarArgs);
		throw new Error('ZIP inspection requires unzip; Windows also supports the built-in tar command');
	}

	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const bytes = statSync(archive).size;
	const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
	if (manifest.archive !== 'squared-squarecloud.zip' || manifest.bytes !== bytes || manifest.sha256 !== sha256) {
		throw new Error('Square Cloud ZIP size or SHA-256 does not match manifest.json');
	}
	if (manifest.product !== 'squared' || manifest.version !== '0.1.0' || manifest.entrypoint !== 'src/main.js') {
		throw new Error('Square Cloud manifest does not describe Squared 0.1.0 at src/main.js');
	}
	if (bytes === 0 || bytes > 100_000_000) throw new Error('Square Cloud ZIP is empty or exceeds the 100 MB upload limit');

	archiveOutput(['-tqq', archive], ['-tf', archive]);
	const entries = archiveOutput(['-Z1', archive], ['-tf', archive]).split(/\r?\n/).filter(Boolean);
	const requiredEntries = [
		'package.json',
		'package-lock.json',
		'vendor/n8n-package-lock.json',
		'squarecloud.app',
		'src/main.js',
		'node_modules/pg/package.json',
	];
	for (const entry of requiredEntries) {
		if (!entries.includes(entry)) throw new Error(`Square Cloud ZIP is missing ${entry}`);
	}
	if (entries.some((entry) => entry.startsWith('packages/') || (entry.startsWith('src/') && /\.(test|spec)\.js$/.test(entry)))) {
		throw new Error('Square Cloud ZIP must not include the historical workspaces or test files');
	}
	if (entries.some((entry) => /(^|\/)\.env(?:\.|$)/.test(entry) || /(^|\/)(id_rsa|credentials\.json|encryption-key|bootstrap-code)$/.test(entry) || /(^|\/)(?:\.)?squared-data(?:\/|$)/.test(entry))) {
		throw new Error('Square Cloud ZIP contains a prohibited environment, credential, or persistent data file');
	}

	const runtimePackage = JSON.parse(archiveOutput(['-p', archive, 'package.json'], ['-xOf', archive, 'package.json']));
	if (runtimePackage.main !== 'src/main.js' || runtimePackage.scripts?.start !== 'node src/main.js') {
		throw new Error('ZIP runtime must start src/main.js through npm start');
	}
	if (!runtimePackage.engines?.node || !/^>=\s*24(?:\.0\.0)?$/.test(runtimePackage.engines.node)) {
		throw new Error('ZIP runtime must declare Node.js 24 or later');
	}
	if (
		!manifest.n8nRuntime ||
		manifest.n8nRuntime.installMode !== 'npm ci on first start into persistent application storage' ||
		manifest.n8nRuntime.persistentDirectory !== 'n8n-nodes/node_modules' ||
		manifest.n8nRuntime.lockfile !== 'vendor/n8n-package-lock.json' ||
		!/^[a-f0-9]{64}$/.test(manifest.n8nRuntime.lockfileSha256 || '') ||
		manifest.n8nRuntime.publishedPackageLicenses !== 'retained in the installed official npm packages' ||
		entries.some((entry) => entry.startsWith('vendor/n8n-runtime'))
	) {
		throw new Error('Square Cloud package must declare persistent npm installation of the official n8n runtime');
	}
	const runtimeLockBytes = archiveOutput(['-p', archive, 'vendor/n8n-package-lock.json'], ['-xOf', archive, 'vendor/n8n-package-lock.json']);
	const runtimeLockSha256 = createHash('sha256').update(runtimeLockBytes).digest('hex');
	const runtimeLock = JSON.parse(runtimeLockBytes);
	if (
		runtimeLockSha256 !== manifest.n8nRuntime.lockfileSha256 ||
		!runtimeLock.packages?.['']?.dependencies ||
		Object.entries(runtimeLock.packages[''].dependencies).some(([name, version]) => manifest.n8nRuntime.packages[name] !== version)
	) {
		throw new Error('Square Cloud package has an invalid n8n runtime lockfile');
	}
	const expectedN8nPackages = {
		'n8n-nodes-base': '2.42.5',
		'@n8n/n8n-nodes-langchain': '2.42.5',
		'n8n-core': '2.42.5',
		'@n8n/backend-common': '1.42.5',
		'n8n-workflow': '2.42.4',
	};
	if (JSON.stringify(manifest.n8nRuntime.packages) !== JSON.stringify(expectedN8nPackages)) {
		throw new Error('Square Cloud package contains an unexpected n8n runtime package set or version');
	}

	const squareCloudConfig = Object.fromEntries(
		archiveOutput(['-p', archive, 'squarecloud.app'], ['-xOf', archive, 'squarecloud.app'])
			.split(/\r?\n/)
			.filter((line) => line && !line.startsWith('#'))
			.map((line) => {
				const separator = line.indexOf('=');
				return [line.slice(0, separator), line.slice(separator + 1)];
			}),
	);
	const expectedConfig = {
		RUNTIME: 'nodejs',
		VERSION: 'recommended',
		MEMORY: process.env.SQUARED_MEMORY_MB || '3072',
		MAIN: 'src/main.js',
		START: 'npm start',
	};
	for (const [key, value] of Object.entries(expectedConfig)) {
		if (squareCloudConfig[key] !== value) throw new Error(`Square Cloud configuration has an unexpected ${key} setting`);
	}
	if (manifest.memoryMb !== Number(expectedConfig.MEMORY)) throw new Error('Square Cloud manifest memory does not match squarecloud.app');

	console.log(`Square Cloud ZIP verified: ${bytes} bytes; SHA-256 ${sha256}`);
	return { archive, manifest, bytes, sha256 };
}

if (import.meta.main) verifySquareCloudPackage();
