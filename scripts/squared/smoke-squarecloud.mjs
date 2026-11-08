import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
const archive = join(output, 'squared-squarecloud.zip');
const temporaryRoot = join(root, '.tmp');
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(join(temporaryRoot, 'squared-smoke-'));
const app = join(temporary, 'app');
mkdirSync(app, { recursive: true });
const dataDir = join(temporary, 'persistent-data');
const password = randomBytes(24).toString('base64url');
const email = `smoke-${randomUUID()}@example.test`;
let backend;

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed (${result.status}); Square Cloud archive validation did not complete`);
	return result.stdout;
}

function hasExecutable(command) {
	return !spawnSync(command, ['--version'], { stdio: 'ignore' }).error;
}

async function freePort() {
	const server = createServer();
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const port = server.address().port;
	await new Promise((done) => server.close(done));
	return port;
}

async function startBackend(port) {
	backend = spawn(process.execPath, ['src/main.js'], {
		cwd: app,
		env: { ...process.env, PORT: String(port), SQUARED_HOST: '127.0.0.1', SQUARED_DATA_DIR: dataDir },
		stdio: 'pipe',
	});
	return `http://127.0.0.1:${port}`;
}

async function waitForReady(base, label) {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (backend.exitCode !== null) throw new Error(`Packed runtime exited during ${label} (exit ${backend.exitCode})`);
		try {
			const response = await fetch(`${base}/healthz/readiness`);
			if (response.ok && (await response.json()).status === 'ok') return;
		} catch {
			// SQLite setup or the HTTP listener is still starting.
		}
		await new Promise((done) => setTimeout(done, 250));
	}
	throw new Error(`Packed runtime did not become ready during ${label}`);
}

async function stopBackend() {
	if (!backend || backend.exitCode !== null) return;
	const exited = new Promise((resolveExit) => backend.once('exit', resolveExit));
	backend.kill('SIGTERM');
	await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
	if (backend.exitCode === null) backend.kill('SIGKILL');
	await Promise.race([new Promise((done) => backend.once('exit', done)), new Promise((done) => setTimeout(done, 2_000))]);
	backend = null;
}

async function api(base, cookie, path, options = {}) {
	return fetch(`${base}${path}`, {
		...options,
		headers: {
			...(cookie ? { cookie } : {}),
			...(options.body ? { 'content-type': 'application/json' } : {}),
			...options.headers,
		},
		signal: AbortSignal.timeout(15_000),
	});
}

if (hasExecutable('unzip')) run('unzip', ['-q', archive, '-d', app]);
else if (process.platform === 'win32' && hasExecutable('tar')) run('tar', ['-xf', archive, '-C', app]);
else throw new Error('ZIP extraction requires unzip; Windows also supports the built-in tar command');
if (!existsSync(join(app, 'node_modules/pg'))) throw new Error('ZIP is missing its optional PostgreSQL runtime dependency');
if (existsSync(join(app, 'packages')) || existsSync(join(app, 'pnpm-workspace.yaml'))) {
	throw new Error('ZIP must not depend on the inherited workspace tree');
}
const runtimeManifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
if (runtimeManifest.version !== '0.1.0' || runtimeManifest.scripts?.start !== 'node src/main.js') {
	throw new Error('ZIP is missing the independent Squared version or npm start entrypoint');
}

const port = await freePort();
let cookie;
let manualExecutionId;
let webhookExecutionId;
let credentialId;
let encryptionKeyBeforeRestart;
const base = await startBackend(port);

try {
	await waitForReady(base, 'first start');
	const editor = await fetch(base);
	if (!editor.ok || !(await editor.text()).includes('<title>Squared</title>')) throw new Error('Editor was not served by the packed runtime');
	const setupState = await api(base, null, '/api/auth/status').then((response) => response.json());
	if (!setupState.setupRequired || setupState.authenticated) throw new Error('First-boot state was not reported by the packed runtime');
	if ((await api(base, null, '/api/workflows')).status !== 401) throw new Error('Workflow API accepted a request without authentication');

	const bootstrapCode = readFileSync(join(dataDir, 'bootstrap-code'), 'utf8');
	const bootstrap = await api(base, null, '/api/auth/bootstrap', {
		method: 'POST',
		body: JSON.stringify({ code: bootstrapCode, email, password }),
	});
	if (bootstrap.status !== 201) throw new Error('Initial administrator setup failed in the packed runtime');
	cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
	if (!cookie) throw new Error('Initial administrator setup did not create a session cookie');
	if (!setupState.setupRequired || !(await api(base, cookie, '/api/auth/status').then((response) => response.json())).authenticated) {
		throw new Error('Admin session was not authenticated after first setup');
	}
	if (existsSync(join(dataDir, 'bootstrap-code'))) throw new Error('Bootstrap code was not removed after admin setup');

	const workflowResponse = await api(base, cookie, '/api/workflows', {
		method: 'POST',
		body: JSON.stringify({
			name: `smoke-manual-${randomUUID()}`,
			active: false,
			nodes: [
				{ id: randomUUID(), type: 'trigger.manual', name: 'Manual', parameters: {} },
				{ id: randomUUID(), type: 'data.set', name: 'Set', parameters: { values: { message: 'sqlite-smoke', run: '={{ $execution.id }}' } } },
			],
		}),
	});
	if (workflowResponse.status !== 201) throw new Error('SQLite workflow create failed');
	const workflow = await workflowResponse.json();
	if ((await api(base, cookie, `/api/workflows/${workflow.id}`).then((response) => response.json())).name !== workflow.name) {
		throw new Error('SQLite workflow readback failed');
	}
	const runResponse = await api(base, cookie, `/api/workflows/${workflow.id}/run`, {
		method: 'POST', body: JSON.stringify({ input: { source: 'local-smoke' } }),
	});
	if (runResponse.status !== 202) throw new Error('Manual workflow trigger failed');
	manualExecutionId = (await runResponse.json()).id;
	const manualExecution = await waitForExecution(base, cookie, manualExecutionId);
	if (manualExecution.status !== 'succeeded' || manualExecution.output?.message !== 'sqlite-smoke' || manualExecution.output?.source !== 'local-smoke') {
		throw new Error('Manual workflow did not return the expected output');
	}

	const webhookResponse = await api(base, cookie, '/api/workflows', {
		method: 'POST',
		body: JSON.stringify({
			name: `smoke-webhook-${randomUUID()}`,
			active: true,
			nodes: [
				{ id: randomUUID(), type: 'trigger.webhook', name: 'Webhook', parameters: {} },
				{ id: randomUUID(), type: 'data.set', name: 'Set', parameters: { values: { echoed: '={{$json.message}}' } } },
			],
		}),
	});
	if (webhookResponse.status !== 201) throw new Error('SQLite webhook workflow create failed');
	const webhookWorkflow = await webhookResponse.json();
	const webhookRun = await api(base, cookie, `/webhook/${webhookWorkflow.id}`, {
		method: 'POST', body: JSON.stringify({ message: 'sqlite-webhook-smoke' }),
	});
	if (webhookRun.status !== 202) throw new Error('Webhook trigger failed');
	webhookExecutionId = (await webhookRun.json()).id;
	const webhookExecution = await waitForExecution(base, cookie, webhookExecutionId);
	if (webhookExecution.status !== 'succeeded' || webhookExecution.output?.echoed !== 'sqlite-webhook-smoke') {
		throw new Error('Webhook workflow did not return the expected output');
	}

	const credentialResponse = await api(base, cookie, '/api/credentials', {
		method: 'POST', body: JSON.stringify({ name: 'smoke-credential', values: { Authorization: 'Bearer smoke-secret' } }),
	});
	if (credentialResponse.status !== 201) throw new Error('SQLite credential create failed');
	credentialId = (await credentialResponse.json()).id;
	const listedCredentials = await api(base, cookie, '/api/credentials').then((response) => response.json());
	if (JSON.stringify(listedCredentials).includes('smoke-secret')) throw new Error('Credential API exposed secret material');
	encryptionKeyBeforeRestart = readFileSync(join(dataDir, 'encryption-key'));

	await stopBackend();
	const { SqliteStore } = await import(pathToFileURL(join(app, 'src/persistence/sqlite.js')).href);
	const { CredentialVault } = await import(pathToFileURL(join(app, 'src/credentials/vault.js')).href);
	const reopenedStore = new SqliteStore(dataDir);
	await reopenedStore.connect();
	const storedCredential = await reopenedStore.getCredential(credentialId);
	if (JSON.stringify(new CredentialVault(encryptionKeyBeforeRestart.toString('utf8')).open(storedCredential.encryptedValue)) !== JSON.stringify({ Authorization: 'Bearer smoke-secret' })) {
		throw new Error('Persisted credential could not be decrypted after restart');
	}
	await reopenedStore.close();

	const restartBase = await startBackend(port);
	await waitForReady(restartBase, 'restart');
	const keyAfterRestart = readFileSync(join(dataDir, 'encryption-key'));
	if (!encryptionKeyBeforeRestart.equals(keyAfterRestart)) throw new Error('Encryption key changed after restart');
	const authenticatedAfterRestart = await api(restartBase, cookie, '/api/auth/status').then((response) => response.json());
	if (!authenticatedAfterRestart.authenticated || authenticatedAfterRestart.setupRequired) throw new Error('Admin session did not survive restart');
	const persistedWorkflow = await api(restartBase, cookie, `/api/workflows/${webhookWorkflow.id}`).then((response) => response.json());
	if (persistedWorkflow.name !== webhookWorkflow.name) throw new Error('Workflow did not survive restart');
	const persistedExecution = await api(restartBase, cookie, `/api/executions/${webhookExecutionId}`).then((response) => response.json());
	if (persistedExecution.status !== 'succeeded') throw new Error('Execution history did not survive restart');
	const logout = await api(restartBase, cookie, '/api/auth/logout', { method: 'POST' });
	if (logout.status !== 204) throw new Error('Admin logout failed after restart');
	if ((await api(restartBase, null, '/api/workflows')).status !== 401) throw new Error('Logged-out API accepted a request');

	console.log('Squared ZIP smoke passed: packed runtime startup, protected first-admin setup, session login/logout, SQLite workflow and execution persistence across restart, credential encryption/key reuse, manual execution and webhook.');
} finally {
	await stopBackend();
	rmSync(temporary, { recursive: true, force: true });
}

async function waitForExecution(baseUrl, sessionCookie, executionId) {
	for (let attempt = 0; attempt < 40; attempt++) {
		const response = await api(baseUrl, sessionCookie, `/api/executions/${executionId}`);
		if (!response.ok) throw new Error('Execution history could not be read');
		const execution = await response.json();
		if (['succeeded', 'failed'].includes(execution.status)) return execution;
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error('Workflow execution did not finish within the smoke-test window');
}
