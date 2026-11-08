import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
const archive = join(output, 'squared-squarecloud.zip');
const databaseUrl = process.env.SQUARED_SMOKE_DATABASE_URL;
if (!databaseUrl) throw new Error('Set SQUARED_SMOKE_DATABASE_URL to a dedicated disposable PostgreSQL database');
if (!existsSync(archive)) throw new Error('Package first with npm run package:squarecloud');

const temporary = mkdtempSync(join(tmpdir(), 'squared-smoke-'));
const app = join(temporary, 'app');
const accessToken = randomBytes(32).toString('base64url');
const encryptionKey = randomBytes(48).toString('base64url');

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
	return result.stdout;
}

async function freePort() {
	const server = createServer();
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const port = server.address().port;
	await new Promise((done) => server.close(done));
	return port;
}

run('unzip', ['-q', archive, '-d', app]);
if (!existsSync(join(app, 'node_modules/pg'))) throw new Error('ZIP is missing its PostgreSQL runtime dependency');
if (existsSync(join(app, 'packages')) || existsSync(join(app, 'pnpm-workspace.yaml'))) {
	throw new Error('ZIP must not depend on the inherited workspace tree');
}
const runtimeManifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
if (runtimeManifest.version !== '0.1.0' || runtimeManifest.scripts?.start !== 'node src/main.js') {
	throw new Error('ZIP is missing the independent Squared version or npm start entrypoint');
}

const port = await freePort();
const env = {
	...process.env,
	PORT: String(port),
	SQUARED_HOST: '127.0.0.1',
	SQUARED_DATABASE_URL: databaseUrl,
	SQUARED_ACCESS_TOKEN: accessToken,
	SQUARED_ENCRYPTION_KEY: encryptionKey,
};
const backend = spawn('npm', ['start'], { cwd: app, env, stdio: 'pipe', detached: process.platform !== 'win32' });
const outputChunks = [];
backend.stdout.on('data', (chunk) => outputChunks.push(chunk));
backend.stderr.on('data', (chunk) => outputChunks.push(chunk));
const base = `http://127.0.0.1:${port}`;

async function api(path, options = {}) {
	return fetch(`${base}${path}`, {
		...options,
		headers: { authorization: `Bearer ${accessToken}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
	});
}

try {
	let ready = false;
	for (let attempt = 0; attempt < 60; attempt++) {
		if (backend.exitCode !== null) throw new Error(`npm start exited: ${Buffer.concat(outputChunks)}`);
		try {
			const response = await fetch(`${base}/healthz/readiness`);
			if (response.ok && (await response.json()).status === 'ok') {
				ready = true;
				break;
			}
		} catch {
			// The PostgreSQL-backed app is still starting.
		}
		await new Promise((done) => setTimeout(done, 500));
	}
	if (!ready) throw new Error(`Readiness timeout: ${Buffer.concat(outputChunks)}`);
	const editor = await fetch(base);
	if (!editor.ok || !(await editor.text()).includes('<title>Squared</title>')) throw new Error('Visual editor was not served');
	const unauthenticated = await fetch(`${base}/api/workflows`);
	if (unauthenticated.status !== 401) throw new Error('API did not enforce the application token');

	const workflowResponse = await api('/api/workflows', {
		method: 'POST',
		body: JSON.stringify({
			name: `smoke-${randomUUID()}`,
			active: false,
			nodes: [
				{ id: randomUUID(), type: 'trigger.manual', name: 'Manual', parameters: {} },
				{ id: randomUUID(), type: 'data.set', name: 'Set', parameters: { values: { message: 'hello', run: '={{ $execution.id }}' } } },
			],
		}),
	});
	if (!workflowResponse.ok) throw new Error(`Workflow save failed: ${await workflowResponse.text()}`);
	const workflow = await workflowResponse.json();
	const runResponse = await api(`/api/workflows/${workflow.id}/run`, { method: 'POST', body: JSON.stringify({ input: { source: 'smoke' } }) });
	if (!runResponse.ok) throw new Error(`Workflow trigger failed: ${await runResponse.text()}`);
	const { id: executionId } = await runResponse.json();
	let execution;
	for (let attempt = 0; attempt < 40; attempt++) {
		const response = await api(`/api/executions/${executionId}`);
		execution = await response.json();
		if (['succeeded', 'failed'].includes(execution.status)) break;
		await new Promise((done) => setTimeout(done, 100));
	}
	if (execution?.status !== 'succeeded' || execution.output?.message !== 'hello' || execution.output?.source !== 'smoke') {
		throw new Error(`Workflow execution failed: ${JSON.stringify(execution)}`);
	}
	const webhookDefinition = await api('/api/workflows', {
		method: 'POST',
		body: JSON.stringify({
			name: `webhook-${randomUUID()}`,
			active: true,
			nodes: [
				{ id: randomUUID(), type: 'trigger.webhook', name: 'Webhook', parameters: {} },
				{ id: randomUUID(), type: 'data.set', name: 'Set', parameters: { values: { echoed: '={{$json.message}}' } } },
			],
		}),
	});
	if (!webhookDefinition.ok) throw new Error(`Webhook workflow save failed: ${await webhookDefinition.text()}`);
	const webhookWorkflow = await webhookDefinition.json();
	const webhookResponse = await api(`/webhook/${webhookWorkflow.id}`, {
		method: 'POST', body: JSON.stringify({ message: 'triggered' }),
	});
	if (!webhookResponse.ok) throw new Error(`Webhook trigger failed: ${await webhookResponse.text()}`);
	const webhookExecutionId = (await webhookResponse.json()).id;
	let webhookExecution;
	for (let attempt = 0; attempt < 40; attempt++) {
		const response = await api(`/api/executions/${webhookExecutionId}`);
		webhookExecution = await response.json();
		if (['succeeded', 'failed'].includes(webhookExecution.status)) break;
		await new Promise((done) => setTimeout(done, 100));
	}
	if (webhookExecution?.status !== 'succeeded' || webhookExecution.output?.echoed !== 'triggered') {
		throw new Error(`Webhook execution failed: ${JSON.stringify(webhookExecution)}`);
	}

	const secretValue = { Authorization: 'Bearer hidden-from-list' };
	const credentialResponse = await api('/api/credentials', {
		method: 'POST', body: JSON.stringify({ name: 'Smoke credential', values: secretValue }),
	});
	if (!credentialResponse.ok) throw new Error(`Credential save failed: ${await credentialResponse.text()}`);
	const credentialId = (await credentialResponse.json()).id;
	const credentials = await api('/api/credentials').then((response) => response.json());
	if (credentials.some((credential) => JSON.stringify(credential).includes('hidden-from-list'))) {
		throw new Error('Credential API exposed secret material');
	}
	await api(`/api/credentials/${credentialId}`, { method: 'DELETE' });

	console.log(`Squared ZIP smoke passed: npm start, PostgreSQL, token auth, visual editor, manual/webhook triggers, workflow execution, credential API (${temporary})`);
} finally {
	if (backend.exitCode === null) {
		if (process.platform !== 'win32') process.kill(-backend.pid, 'SIGTERM');
		else backend.kill('SIGTERM');
		await Promise.race([
			new Promise((done) => backend.once('exit', done)),
			new Promise((done) => setTimeout(done, 5_000)),
		]);
		if (backend.exitCode === null && process.platform !== 'win32') {
			try {
				process.kill(-backend.pid, 'SIGKILL');
			} catch (error) {
				if (error.code !== 'ESRCH') throw error;
			}
		}
	}
	rmSync(temporary, { recursive: true, force: true });
}
