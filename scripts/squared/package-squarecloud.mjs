import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
const app = join(output, 'app');
const archive = join(output, 'n8n-squared-squarecloud.zip');
const maxUploadBytes = 100 * 1024 * 1024;

function run(command, args, cwd = root, quiet = false) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: quiet ? 'pipe' : 'inherit',
		env: process.env,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status}\n${result.stderr || ''}`);
	}
	return result.stdout || '';
}

const workspace = JSON.parse(run('pnpm', ['-r', 'list', '--depth', '-1', '--json'], root, true));
const byName = new Map(workspace.map(({ name, path }) => [name, path]));
const required = new Set();
const pending = ['n8n'];
while (pending.length) {
	const name = pending.pop();
	if (required.has(name)) continue;
	const location = byName.get(name);
	if (!location) throw new Error(`Missing workspace package ${name}`);
	required.add(name);
	const pkg = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
	for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
		if (byName.has(dependency)) pending.push(dependency);
	}
}

const displayName = process.env.SQUARED_DISPLAY_NAME || 'n8n-squared';
if (/\r|\n|=/.test(displayName)) throw new Error('Invalid SQUARED_DISPLAY_NAME');
const memory = process.env.SQUARED_MEMORY_MB || '2048';
if (!/^\d+$/.test(memory) || Number(memory) < 512) {
	throw new Error('SQUARED_MEMORY_MB must be an integer of at least 512');
}
const subdomain = process.env.SQUARED_SUBDOMAIN;
if (subdomain && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(subdomain)) {
	throw new Error('SQUARED_SUBDOMAIN must be a valid lower-case DNS label');
}

rmSync(output, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
const packDir = join(output, '.pack');
mkdirSync(packDir);

try {
	for (const name of [...required].sort()) {
		const source = byName.get(name);
		const destination = join(app, relative(root, source));
		mkdirSync(destination, { recursive: true });
		const packageDir = join(packDir, name.replaceAll('/', '-'));
		mkdirSync(packageDir);
		run('pnpm', ['pack', '--pack-destination', packageDir], source, true);
		const tarball = readdirSync(packageDir).find((file) => file.endsWith('.tgz'));
		if (!tarball) throw new Error(`No package tarball for ${name}`);
		run('tar', ['-xzf', join(packageDir, tarball), '--strip-components=1', '-C', destination]);

		// pnpm pack rewrites workspace:* to publish versions. Restore the original
		// runtime dependencies so pnpm links our compiled workspace packages.
		const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
		delete pkg.devDependencies;
		delete pkg.scripts;
		delete pkg.publishConfig;
		writeFileSync(join(destination, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
		console.log(`Packed ${name}`);
	}
} finally {
	rmSync(packDir, { recursive: true, force: true });
}

for (const name of [
	'pnpm-workspace.yaml',
	'pnpm-lock.yaml',
	'LICENSE.md',
	'LICENSE_EE.md',
	'UPSTREAM.md',
]) {
	copyFileSync(join(root, name), join(app, name));
}
cpSync(join(root, 'patches'), join(app, 'patches'), { recursive: true });
copyFileSync(join(root, 'deploy/squarecloud/start.cjs'), join(app, 'start.cjs'));
writeFileSync(
	join(app, 'package.json'),
	`${JSON.stringify(
		{
			name: 'n8n-squared-deploy',
			private: true,
			packageManager: 'pnpm@12.4.2',
			engines: { node: '>=24' },
			scripts: { start: 'node start.cjs' },
		},
		null,
		2,
	)}\n`,
);
writeFileSync(
	join(app, 'squarecloud.app'),
	[
		`DISPLAY_NAME=${displayName}`,
		`MEMORY=${memory}`,
		'VERSION=recommended',
		'MAIN=start.cjs',
		...(subdomain ? [`SUBDOMAIN=${subdomain}`] : []),
		'',
	].join('\n'),
);

// Rebase the production lockfile on the upstream-pinned versions. This avoids
// resolving newer registry releases during packaging and makes hosted installs frozen.
run('pnpm', ['install', '--lockfile-only', '--prod', '--ignore-scripts'], app);
run('zip', ['-q', '-r', archive, '.'], app);
run('unzip', ['-tqq', archive]);
const bytes = statSync(archive).size;
if (bytes > maxUploadBytes) {
	throw new Error(`Square Cloud upload limit exceeded: ${bytes} > ${maxUploadBytes} bytes`);
}
if (existsSync(join(app, 'node_modules'))) throw new Error('Upload must not contain node_modules');

const manifest = {
	upstream: 'n8n@2.42.7',
	archive: 'n8n-squared-squarecloud.zip',
	bytes,
	sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
	entrypoint: 'start.cjs',
	workspacePackages: required.size,
	install: 'pnpm install --prod --frozen-lockfile',
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
