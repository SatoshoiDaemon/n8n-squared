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

	run('unzip', ['-tqq', archive]);
	const entries = run('unzip', ['-Z1', archive]).split(/\r?\n/).filter(Boolean);
	const requiredEntries = ['package.json', 'package-lock.json', 'squarecloud.app', 'src/main.js', 'node_modules/pg/package.json'];
	for (const entry of requiredEntries) {
		if (!entries.includes(entry)) throw new Error(`Square Cloud ZIP is missing ${entry}`);
	}
	if (entries.some((entry) => entry.startsWith('packages/') || (entry.startsWith('src/') && /\.(test|spec)\.js$/.test(entry)))) {
		throw new Error('Square Cloud ZIP must not include the historical workspaces or test files');
	}
	if (entries.some((entry) => /(^|\/)\.env(?:\.|$)/.test(entry) || /(^|\/)(id_rsa|credentials\.json)$/.test(entry))) {
		throw new Error('Square Cloud ZIP contains a prohibited environment or credential file');
	}

	const runtimePackage = JSON.parse(run('unzip', ['-p', archive, 'package.json']));
	if (runtimePackage.main !== 'src/main.js' || runtimePackage.scripts?.start !== 'node src/main.js') {
		throw new Error('ZIP runtime must start src/main.js through npm start');
	}
	if (!runtimePackage.engines?.node || !/^>=\s*24(?:\.0\.0)?$/.test(runtimePackage.engines.node)) {
		throw new Error('ZIP runtime must declare Node.js 24 or later');
	}

	const squareCloudConfig = Object.fromEntries(
		run('unzip', ['-p', archive, 'squarecloud.app'])
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
		MEMORY: process.env.SQUARED_MEMORY_MB || '1024',
		MAIN: 'src/main.js',
		START: 'npm start',
	};
	for (const [key, value] of Object.entries(expectedConfig)) {
		if (squareCloudConfig[key] !== value) throw new Error(`Square Cloud configuration has an unexpected ${key} setting`);
	}

	console.log(`Square Cloud ZIP verified: ${bytes} bytes; SHA-256 ${sha256}`);
	return { archive, manifest, bytes, sha256 };
}

if (import.meta.main) verifySquareCloudPackage();
