import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const archive = resolve(
	root,
	process.env.SQUARED_DIST_DIR || 'dist/squarecloud',
	'n8n-squared-squarecloud.zip',
);
const fixture = join(root, 'scripts/squared/fixtures/smoke-workflow.json');
if (!existsSync(archive)) throw new Error('Package first with pnpm package:squarecloud');

const temporary = mkdtempSync(join(tmpdir(), 'n8n-squared-smoke-'));
const app = join(temporary, 'app');
const data = join(temporary, 'data');
mkdirSync(app);
mkdirSync(data);

function run(command, args, cwd = app, env = process.env) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: 'utf8',
		maxBuffer: 20 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

async function freePort() {
	const server = createServer();
	await new Promise((resolvePort) => server.listen(0, '127.0.0.1', resolvePort));
	const port = server.address().port;
	await new Promise((resolveClose) => server.close(resolveClose));
	return port;
}

run('unzip', ['-q', archive, '-d', app]);
if (existsSync(join(app, 'node_modules'))) throw new Error('ZIP contains node_modules');
run('pnpm', ['install', '--prod', '--frozen-lockfile']);

const port = await freePort();
const brokerPort = await freePort();
const env = {
	...process.env,
	N8N_USER_FOLDER: data,
	N8N_PORT: String(port),
	N8N_RUNNERS_BROKER_PORT: String(brokerPort),
	N8N_LISTEN_ADDRESS: '127.0.0.1',
	N8N_DIAGNOSTICS_ENABLED: 'false',
	N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
};
const backend = spawn(process.execPath, ['start.cjs'], { cwd: app, env, stdio: 'pipe' });
const output = [];
backend.stdout.on('data', (chunk) => output.push(chunk));
backend.stderr.on('data', (chunk) => output.push(chunk));
const base = `http://127.0.0.1:${port}`;

try {
	let healthy = false;
	for (let attempt = 0; attempt < 90; attempt++) {
		if (backend.exitCode !== null)
			throw new Error(`Backend exited: ${Buffer.concat(output).toString()}`);
		try {
			const response = await fetch(`${base}/healthz/readiness`);
			if (response.ok && (await response.json()).status === 'ok') {
				healthy = true;
				break;
			}
		} catch {
			// The server is still starting.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
	}
	if (!healthy) throw new Error(`Readiness timeout: ${Buffer.concat(output).toString()}`);
	const editor = await fetch(base);
	if (!editor.ok || !(await editor.text()).includes('<!DOCTYPE html>')) {
		throw new Error(`Editor unavailable: HTTP ${editor.status}`);
	}
	const owner = await fetch(`${base}/rest/owner/setup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: 'smoke@example.invalid',
			firstName: 'Smoke',
			lastName: 'Test',
			password: 'LocalOnly-42-Test!',
		}),
	});
	if (!owner.ok) throw new Error(`Owner setup failed: HTTP ${owner.status}`);
} finally {
	backend.kill('SIGINT');
	await new Promise((resolveExit) => backend.once('exit', resolveExit));
	writeFileSync(join(temporary, 'backend.log'), Buffer.concat(output));
}

run(process.execPath, ['packages/cli/bin/n8n', 'import:workflow', `--input=${fixture}`], app, env);
const execution = run(
	process.execPath,
	['packages/cli/bin/n8n', 'execute', '--id=9f39c310-918a-4e83-870b-7d31e9cd24db', '--rawOutput'],
	app,
	env,
);
if (!execution.includes('"status": "success"') || !execution.includes('"finished": true')) {
	throw new Error(`Workflow did not finish successfully: ${execution}`);
}
console.log(`Square Cloud ZIP smoke passed: readiness, editor, import, execution (${temporary})`);
