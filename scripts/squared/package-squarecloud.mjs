import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
const app = join(output, 'app');
const archive = join(output, 'squared-squarecloud.zip');
const maxUploadBytes = 100_000_000;

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: 'inherit',
		env: process.env,
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
		'VERSION=recommended',
		'MAIN=src/main.js',
		...(subdomain ? [`SUBDOMAIN=${subdomain}`] : []),
		'',
	].join('\n'),
);

// The deploy ZIP is a conventional Node app. It has no workspace install or build step.
run('npm', ['ci', '--omit=dev', '--ignore-scripts'], app);
run('zip', ['-q', '-r', archive, '.'], app);
run('unzip', ['-tqq', archive]);
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
