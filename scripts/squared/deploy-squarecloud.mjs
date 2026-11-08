import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	SquareCloudApiError,
	SquareCloudClient,
	appIsRunning,
	inspectSquareCloud,
	requireTargetAppId,
	runtimeEnvironmentReport,
	writeActionSummary,
} from './squarecloud-client.mjs';
import { verifySquareCloudPackage } from './verify-squarecloud.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, process.env.SQUARED_DIST_DIR || 'dist/squarecloud');
const archive = resolve(output, 'squared-squarecloud.zip');
const manifestPath = resolve(output, 'manifest.json');
const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

let snapshot;
let commitMayHaveApplied = false;
let rollbackResult = 'not needed';
let appUrl;
let previousVersionWasResponsive = false;

try {
	verifySquareCloudPackage();
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const zipHash = createHash('sha256').update(readFileSync(archive)).digest('hex');
	if (zipHash !== manifest.sha256) throw new Error('Square Cloud ZIP SHA-256 does not match manifest.json');

	const appId = requireTargetAppId();
	const client = new SquareCloudClient(process.env.SQUARECLOUD_API_KEY);
	const inspection = await inspectSquareCloud({ client, appId, includeMetrics: false });
	if (inspection.accessFailures.length) {
		throw new Error(`Required read scopes are missing: ${inspection.accessFailures.join('; ')}`);
	}
	if (!inspection.appUrl || !inspection.application) {
		throw new Error('Square Cloud could not provide the application domain or metadata required for production verification');
	}
	appUrl = inspection.appUrl;
	const environment = runtimeEnvironmentReport(inspection.envs);
	if (environment.requirements.length) {
		throw new Error(`Production runtime environment is incomplete or incompatible: ${environment.requirements.join(', ')}`);
	}

	previousVersionWasResponsive = await existingVersionResponds(inspection.appUrl, inspection.appStatus);
	console.log('Pre-deploy checks passed: target, optional runtime settings, HTTP binding, app status, and package.');
	if (previousVersionWasResponsive) {
		snapshot = await createPreDeploySnapshot(client, appId);
		console.log(`Pre-deploy Square Cloud snapshot ready: ${snapshot.name}`);
	} else {
		console.log('No responsive previous application version; this first deploy does not require a recovery snapshot.');
	}

	const form = new FormData();
	form.append('file', new Blob([readFileSync(archive)], { type: 'application/zip' }), 'squared-squarecloud.zip');
	try {
		await client.post(`/apps/${encodeURIComponent(appId)}/commit`, form, { timeoutMs: 180_000 });
		commitMayHaveApplied = true;
	} catch (error) {
		const knownRejected = new Set([
			'APP_NOT_FOUND',
			'COMMIT_FAILED',
			'FILE_TOO_LARGE',
			'INVALID_CONTENT_TYPE',
			'INVALID_FILE',
			'INVALID_FILENAME',
			'INVALID_PATH',
			'MISSING_SCOPE',
			'UPLOAD_BUSY',
		]);
		commitMayHaveApplied = !(error instanceof SquareCloudApiError && knownRejected.has(error.code));
		throw error;
	}
	console.log('ZIP commit accepted by the Square Cloud API.');

	const deploymentStartedAt = Date.now();
	if (appIsRunning(inspection.appStatus)) {
		await client.post(`/apps/${encodeURIComponent(appId)}/restart`);
	} else {
		await client.post(`/apps/${encodeURIComponent(appId)}/start`);
	}

	const ready = await waitForReadiness({ client, appId, appUrl: inspection.appUrl, startedAt: deploymentStartedAt });
	const idleStatus = await client.get(`/apps/${encodeURIComponent(appId)}/status`);
	const startup = await waitForStartupLog(client, appId);
	if (startup && Number(startup.nodeVersion.split('.')[0]) !== 24) {
		throw new Error(`Square Cloud started Squared on Node ${startup.nodeVersion}; Node.js 24 is required`);
	}
	const n8nRuntime = await waitForN8nRuntimeLog(client, appId, manifest.n8nRuntime);

	const smoke = await runProductionSmoke({
		client,
		appId,
		appUrl: inspection.appUrl,
		accessToken: inspection.envs.SQUARED_ACCESS_TOKEN,
	});
	const postStatus = await client.get(`/apps/${encodeURIComponent(appId)}/status`);
	const logs = await client.get(`/apps/${encodeURIComponent(appId)}/logs`).catch(() => null);
	const metrics = await client.get(`/apps/${encodeURIComponent(appId)}/metrics?range=24h`).catch(() => null);
	const sampledMetrics = (Array.isArray(metrics) ? metrics : []).filter((sample) => Date.parse(sample.date) >= deploymentStartedAt);
	const startupSamples = sampledMetrics.filter((sample) => Date.parse(sample.date) <= ready.readyAt);
	const runSamples = smoke.samplesDuringExecution;
	const errors = countRuntimeErrors(logs?.logs || '');
	const zipBytes = statSync(archive).size;
	const metricsLatest = latestSample(sampledMetrics);
	const rows = [
		['Deployment', 'successful; ZIP committed and application is running'],
		['Application', `${inspection.appUrl} (${appId})`],
		['Runtime', startup ? `Squared ${manifest.version}; Node ${startup.nodeVersion}; ${startup.host}:${startup.port}` : `Squared ${manifest.version}; startup log unavailable`],
		['Profile', '1024 MB configured; SQLite on persistent application storage by default'],
		['Artifact', `${zipBytes} bytes; SHA-256 ${manifest.sha256}`],
		['Official n8n runtime', `${n8nRuntime.nodes} package node types discovered; ${n8nRuntime.installMode}; pinned seed ${manifest.n8nRuntime.seedBytes} bytes`],
		['Pre-deploy snapshot', snapshot ? `${snapshot.name} (${snapshot.versionId})` : 'not required; no responsive previous version'],
		['Readiness time', `${(ready.readyAt - deploymentStartedAt) / 1000}s from start/restart request`],
		['Health/editor/auth', 'healthz, readiness, editor, first-boot state and protected API checks passed'],
		['Production smoke', smoke.mode === 'integration token' ? 'Authenticated workflow persistence, official n8n Set and Code execution, webhook execution and cleanup passed' : 'Safe public checks passed; no account or workflows were created'],
		['Memory at rest', idleStatus.ram || 'not reported by status endpoint'],
		['CPU at rest', idleStatus.cpu || 'not reported by status endpoint'],
		['Startup peak memory', summarizePeak(startupSamples, 'ram')],
		['Workflow CPU/RAM sample', summarizeResources(runSamples)],
		['Latest post-deploy metric', metricsLatest ? `${metricsLatest.date}: CPU ${metricsLatest.cpu}%, RAM ${metricsLatest.ram} MB` : 'no fresh five-minute metric sample available'],
		['Application status/uptime', `${postStatus.status || 'unknown'}; ${summarizeUptime(postStatus.uptime)}`],
		['Restart/error data', `restart count not exposed by documented API; ${errors} error-like log lines in fetched logs`],
		['Previous state', `${inspection.appStatus.status || 'unknown'} before deploy; one start/restart request was issued to apply the ZIP`],
	];
	writeActionSummary('Squared production deploy', rows);
} catch (error) {
	if (commitMayHaveApplied && snapshot) rollbackResult = await tryRestoreSnapshot(snapshot, appUrl);
	const message = safeError(error);
	writeActionSummary('Square Cloud deploy did not complete', [
		['Result', message],
		['Recovery', rollbackResult],
		['Snapshot', snapshot ? `${snapshot.name} (${snapshot.versionId})` : 'no new deploy snapshot was required or available'],
	]);
	console.error(`Square Cloud deploy failed: ${message}`);
	process.exitCode = 1;
}

async function createPreDeploySnapshot(client, appId) {
	const createdAt = Date.now();
	let expectedName;
	try {
		const created = await client.post(`/apps/${encodeURIComponent(appId)}/snapshots`);
		if (created?.url) {
			expectedName = decodeURIComponent(new URL(created.url).pathname.split('/').at(-1) || '').replace(/\.zip$/, '');
		}
	} catch (error) {
		if (!(error instanceof SquareCloudApiError) || error.code !== 'SNAPSHOT_PROCESSING') throw error;
	}

	const deadline = Date.now() + 160_000;
	while (Date.now() < deadline) {
		const listed = await client.get(`/apps/${encodeURIComponent(appId)}/snapshots`);
		const snapshots = Array.isArray(listed) ? listed : [];
		const recent = snapshots
			.filter((entry) => {
				const modifiedAt = Date.parse(entry.modified || '');
				return Number.isFinite(modifiedAt) && modifiedAt >= createdAt - 5_000;
			})
			.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
		const created = (expectedName && recent.find((entry) => entry.name === expectedName)) || recent.find((entry) => entry.origin === 'manual');
		if (created?.name && created?.version_id) {
			return { name: created.name, versionId: created.version_id, size: created.size, modified: created.modified };
		}
		await wait(5_000);
	}
	throw new Error('Square Cloud did not expose the new pre-deploy snapshot within 160 seconds; no ZIP was committed');
}

async function existingVersionResponds(appUrl, status) {
	if (!appIsRunning(status)) return false;
	try {
		const response = await fetch(appUrl, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
		if (response.status < 200 || response.status >= 400) {
			await response.body?.cancel();
			return false;
		}
		const page = await response.text();
		return /<title>\s*(?:Squared|n8n)\b/i.test(page);
	} catch {
		return false;
	}
}

async function waitForReadiness({ client, appId, appUrl, startedAt, expectedProduct = 'squared' }) {
	const deadline = Date.now() + 600_000;
	let apiRunning = false;
	let health = false;
	let readyAt;
	while (Date.now() < deadline) {
		try {
			const status = await client.get(`/apps/${encodeURIComponent(appId)}/status`);
			apiRunning = appIsRunning(status);
		} catch {
			apiRunning = false;
		}
		if (apiRunning) {
			for (const path of expectedProduct ? ['/healthz', '/healthz/readiness'] : ['/healthz/readiness', '/']) {
				try {
					const response = await fetch(new URL(path, appUrl), { signal: AbortSignal.timeout(5_000) });
					if (!response.ok) continue;
					const payload = expectedProduct ? await response.json() : null;
					if (
						!expectedProduct ||
						(payload.status === 'ok' && payload.product === expectedProduct && payload.version === '0.1.0')
					) {
						health = true;
						break;
					}
				} catch {
					// The application is still booting or its public route is not ready yet.
				}
			}
		}
		if (apiRunning && health) {
			readyAt = Date.now();
			break;
		}
		await wait(3_000);
	}
	if (!readyAt) throw new Error('Square Cloud application did not reach /healthz/readiness within 600 seconds');
	return { readyAt, readyMs: readyAt - startedAt };
}

async function waitForStartupLog(client, appId) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const result = await client.get(`/apps/${encodeURIComponent(appId)}/logs`);
			const match = String(result?.logs || '').match(/Squared ([\d.]+) \(Node ([\d.]+)\) listening on http:\/\/([^:]+):(\d+)/);
			if (match) return { version: match[1], nodeVersion: match[2], host: match[3], port: match[4] };
		} catch {
			// Logs can lag behind the health endpoint by a few seconds.
		}
		await wait(2_000);
	}
	return null;
}

async function waitForN8nRuntimeLog(client, appId, expectedRuntime) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const result = await client.get(`/apps/${encodeURIComponent(appId)}/logs`);
			const logs = String(result?.logs || '');
			const installMatch = logs.match(/Official n8n runtime packages (installed|available) \(([^)]+)\)/);
			const nodesMatch = logs.match(/Loaded n8n package manifests: ([^\r\n]+?) \((\d+) nodes discovered\)/);
			if (installMatch && nodesMatch) {
				const packages = nodesMatch[1].split(',').map((name) => name.trim());
				const required = ['n8n-nodes-base', '@n8n/n8n-nodes-langchain'];
				if (required.some((name) => !packages.includes(name))) {
					throw new Error('Production did not load both pinned official n8n node packages');
				}
				const nodes = Number(nodesMatch[2]);
				if (!Number.isInteger(nodes) || nodes < 569) throw new Error(`Production discovered ${nodes} official node records; expected at least 569`);
				if (!expectedRuntime?.packages || expectedRuntime.packages['n8n-nodes-base'] !== '2.42.5') {
					throw new Error('The deployed artifact does not declare the expected n8n-nodes-base version');
				}
				return { nodes, installMode: installMatch[1] };
			}
		} catch (error) {
			if (error instanceof Error && /Production did not|Production discovered|deployed artifact/.test(error.message)) throw error;
			// The process can become healthy before Square Cloud publishes its startup logs.
		}
		await wait(2_000);
	}
	throw new Error('Square Cloud did not log that the pinned n8n runtime packages were installed and discovered');
}

async function runProductionSmoke({ client, appId, appUrl, accessToken }) {
	const samplesDuringExecution = [];
	const apiUrl = (path) => new URL(path, appUrl);
	const api = (path, options = {}, token = accessToken) => fetch(apiUrl(path), {
		...options,
		headers: {
			...(options.body ? { 'content-type': 'application/json' } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...options.headers,
		},
		signal: AbortSignal.timeout(15_000),
	});

	const root = await fetch(appUrl, { signal: AbortSignal.timeout(15_000) });
	if (!root.ok || !(await root.text()).includes('<title>Squared</title>')) throw new Error('Production editor page was not served');
	const authStateResponse = await api('/api/auth/status', {}, null);
	if (!authStateResponse.ok) throw new Error('Production first-boot status endpoint was unavailable');
	const authState = await authStateResponse.json();
	if (typeof authState.setupRequired !== 'boolean' || typeof authState.authenticated !== 'boolean') {
		throw new Error('Production first-boot status response was invalid');
	}
	const unauthenticated = await api('/api/workflows', {}, null);
	if (unauthenticated.status !== 401) throw new Error('Production workflow API did not enforce authentication');

	if (authState.setupRequired) {
		const bootstrapAttempt = await api('/api/auth/bootstrap', {
			method: 'POST',
			body: JSON.stringify({
				code: randomBytes(32).toString('base64url'),
				email: 'squared-smoke@example.invalid',
				password: randomBytes(24).toString('base64url'),
			}),
		}, null);
		if (bootstrapAttempt.status !== 403) throw new Error('Production first-admin setup accepted an invalid bootstrap code');
		const stateAfterProbe = await api('/api/auth/status', {}, null).then((response) => response.json());
		if (!stateAfterProbe.setupRequired) throw new Error('Production smoke unexpectedly changed first-admin setup state');
	}

	if (!accessToken) return { samplesDuringExecution, mode: 'public checks' };
	return { ...(await runAuthenticatedProductionSmoke({ api, client, appId, samplesDuringExecution })), mode: 'integration token' };
}

async function runAuthenticatedProductionSmoke({ api, client, appId, samplesDuringExecution }) {
	const authenticated = await api('/api/workflows');
	if (!authenticated.ok || !Array.isArray(await authenticated.json())) throw new Error('Production workflow API did not accept its configured integration token');
	let manualWorkflowId;
	let webhookWorkflowId;
	let n8nWorkflowId;
	const executionIds = [];
	let cleanupFailed = false;
	try {
		const manualName = `Tarefa 004 smoke manual ${randomUUID()}`;
		const manual = await postWorkflow(api, {
			name: manualName,
			active: false,
			nodes: [
				{ id: randomUUID(), type: 'trigger.manual', name: 'Manual', parameters: {} },
				{ id: randomUUID(), type: 'data.set', name: 'Set', parameters: { values: { message: 'tarefa-004-smoke', run: '={{ $execution.id }}' } } },
			],
		});
		manualWorkflowId = manual.id;
		const persistedManual = await api(`/api/workflows/${encodeURIComponent(manualWorkflowId)}`);
		if (!persistedManual.ok || (await persistedManual.json()).name !== manualName) {
			throw new Error('Production workflow create/read persistence check failed');
		}

		const manualRun = await api(`/api/workflows/${encodeURIComponent(manualWorkflowId)}/run`, {
			method: 'POST', body: JSON.stringify({ input: { source: 'tarefa-004-smoke' } }),
		});
		if (manualRun.status !== 202) throw new Error(`Manual production workflow returned HTTP ${manualRun.status}`);
		const manualExecutionId = (await manualRun.json()).id;
		executionIds.push(manualExecutionId);
		const manualExecution = await waitForExecution(api, client, appId, manualExecutionId, samplesDuringExecution);
		if (manualExecution.status !== 'succeeded' || manualExecution.output?.message !== 'tarefa-004-smoke' || manualExecution.output?.source !== 'tarefa-004-smoke') {
			throw new Error('Production manual workflow execution did not return the expected output');
		}

		const n8nWorkflow = await postN8nWorkflow(api, {
			name: `squared-e2e-n8n-node-${randomUUID()}`,
			nodes: [
				{ id: randomUUID(), name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
				{ id: randomUUID(), name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.5, position: [260, 0], parameters: { mode: 'manual', assignments: { assignments: [{ id: randomUUID(), name: 'compatibility', value: '={{$json.value}}', type: 'string' }] }, includeOtherFields: true, options: {} } },
				{ id: randomUUID(), name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [520, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 'return $input.all().map(item => ({ json: { ...item.json, codeExecuted: true } }));' } },
			],
			connections: {
				'Manual Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
				Set: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
			},
		});
		n8nWorkflowId = n8nWorkflow.id;
		const n8nRun = await api(`/api/workflows/${encodeURIComponent(n8nWorkflowId)}/run`, {
			method: 'POST', body: JSON.stringify({ input: { value: 'official-node-production-smoke' } }),
		});
		if (n8nRun.status !== 202) throw new Error(`Published n8n node workflow returned HTTP ${n8nRun.status}`);
		const n8nExecutionId = (await n8nRun.json()).id;
		executionIds.push(n8nExecutionId);
		const n8nExecution = await waitForExecution(api, client, appId, n8nExecutionId, samplesDuringExecution);
		if (n8nExecution.status !== 'succeeded' || n8nExecution.output?.output?.[0]?.json?.compatibility !== 'official-node-production-smoke' || n8nExecution.output?.output?.[0]?.json?.codeExecuted !== true) {
			throw new Error('Published n8n Set v3.5 and Code v2 did not execute with the expected production output');
		}

		const webhookName = `Tarefa 004 smoke webhook ${randomUUID()}`;
		const webhook = await postWorkflow(api, {
			name: webhookName,
			active: true,
			nodes: [
				{ id: randomUUID(), type: 'trigger.webhook', name: 'Webhook', parameters: {} },
				{ id: randomUUID(), type: 'data.set', name: 'Set', parameters: { values: { echoed: '={{$json.message}}' } } },
			],
		});
		webhookWorkflowId = webhook.id;
		const persistedWebhook = await api(`/api/workflows/${encodeURIComponent(webhookWorkflowId)}`);
		if (!persistedWebhook.ok || (await persistedWebhook.json()).name !== webhookName) {
			throw new Error('Production webhook workflow was not readable after creation');
		}

		const webhookRun = await api(`/webhook/${encodeURIComponent(webhookWorkflowId)}`, {
			method: 'POST', body: JSON.stringify({ message: 'tarefa-004-webhook-smoke' }),
		});
		if (webhookRun.status !== 202) throw new Error(`Production webhook returned HTTP ${webhookRun.status}`);
		const webhookExecutionId = (await webhookRun.json()).id;
		executionIds.push(webhookExecutionId);
		const webhookExecution = await waitForExecution(api, client, appId, webhookExecutionId, samplesDuringExecution);
		if (webhookExecution.status !== 'succeeded' || webhookExecution.output?.echoed !== 'tarefa-004-webhook-smoke') {
			throw new Error('Production webhook workflow execution did not return the expected output');
		}
	} finally {
		for (const workflowId of [webhookWorkflowId, n8nWorkflowId, manualWorkflowId].filter(Boolean)) {
			try {
				const deleted = await api(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
				if (deleted.status !== 204) cleanupFailed = true;
			} catch {
				cleanupFailed = true;
			}
		}
		for (const executionId of executionIds) {
			try {
				const deleted = await api(`/api/executions/${encodeURIComponent(executionId)}`, { method: 'DELETE' });
				if (deleted.status !== 204) cleanupFailed = true;
			} catch {
				cleanupFailed = true;
			}
		}
	}
	if (cleanupFailed) throw new Error('Production smoke passed partially but temporary workflows could not all be removed');
	return { samplesDuringExecution };
}

async function postWorkflow(api, definition) {
	const response = await api('/api/workflows', { method: 'POST', body: JSON.stringify(definition) });
	if (response.status !== 201) throw new Error(`Production workflow creation returned HTTP ${response.status}`);
	const result = await response.json();
	if (!result.id) throw new Error('Production workflow creation did not return an identifier');
	return result;
}

async function postN8nWorkflow(api, definition) {
	const response = await api('/api/workflows/import', { method: 'POST', body: JSON.stringify(definition) });
	if (response.status !== 201) throw new Error(`Production n8n workflow import returned HTTP ${response.status}`);
	const result = await response.json();
	if (!result.id) throw new Error('Production n8n workflow import did not return an identifier');
	return result;
}

async function waitForExecution(api, client, appId, executionId, samples) {
	const encodedId = encodeURIComponent(executionId);
	for (let attempt = 0; attempt < 40; attempt++) {
		const response = await api(`/api/executions/${encodedId}`);
		if (!response.ok) throw new Error(`Production execution read returned HTTP ${response.status}`);
		const execution = await response.json();
		if (execution.status === 'running') {
			const status = await client.get(`/apps/${encodeURIComponent(appId)}/status`).catch(() => null);
			if (status) samples.push(status);
		}
		if (['succeeded', 'failed'].includes(execution.status)) return execution;
		await wait(250);
	}
	throw new Error('Production workflow execution did not finish within 10 seconds');
}

async function tryRestoreSnapshot(value, targetUrl) {
	try {
		const client = new SquareCloudClient(process.env.SQUARECLOUD_API_KEY);
		await client.post(`/apps/${encodeURIComponent(requireTargetAppId())}/snapshots/restore`, {
			snapshotId: value.name,
			versionId: value.versionId,
		});
		await waitForReadiness({
			client,
			appId: requireTargetAppId(),
			appUrl: targetUrl,
			startedAt: Date.now(),
			expectedProduct: null,
		});
		return 'pre-deploy snapshot restored; health endpoint is responding';
	} catch (error) {
		return `automatic restore could not be confirmed (${safeError(error)}); snapshot is available for manual recovery`;
	}
}

function summarizePeak(samples, key) {
	if (samples.length === 0) return 'not available; Square Cloud metrics sample every five minutes';
	const peak = Math.max(...samples.map((sample) => Number(sample[key])).filter(Number.isFinite));
	return Number.isFinite(peak) ? `${peak} MB from fresh startup samples` : 'not available';
}

function summarizeResources(samples) {
	if (samples.length === 0) return 'not sampled while an execution was running';
	const latest = samples.at(-1);
	return `CPU ${latest.cpu || 'not reported'}, RAM ${latest.ram || 'not reported'}`;
}

function summarizeUptime(value) {
	if (value === undefined || value === null || value === '') return 'not reported';
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return String(value);
	if (numeric > 1_000_000_000_000) {
		const startedAt = new Date(numeric);
		const elapsedMs = Date.now() - numeric;
		if (!Number.isFinite(startedAt.getTime()) || elapsedMs < 0) return String(value);
		return `${formatDuration(elapsedMs)} (since ${startedAt.toISOString()})`;
	}
	return numeric >= 0 ? formatDuration(numeric) : String(value);
}

function formatDuration(milliseconds) {
	const seconds = Math.floor(milliseconds / 1000);
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const remainingSeconds = seconds % 60;
	return days ? `${days}d ${hours}h ${minutes}m` : hours ? `${hours}h ${minutes}m ${remainingSeconds}s` : `${minutes}m ${remainingSeconds}s`;
}

function latestSample(samples) {
	return [...samples].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
}

function countRuntimeErrors(logs) {
	return logs.split(/\r?\n/).filter((line) => /\b(error|fatal|uncaught)\b/i.test(line)).length;
}

function safeError(error) {
	if (error?.code && error?.status !== undefined) return `${error.code} (HTTP ${error.status})`;
	return error instanceof Error ? error.message : 'unknown error';
}
