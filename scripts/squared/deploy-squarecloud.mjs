import { createHash, randomUUID } from 'node:crypto';
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

try {
	verifySquareCloudPackage();
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const zipHash = createHash('sha256').update(readFileSync(archive)).digest('hex');
	if (zipHash !== manifest.sha256) throw new Error('Square Cloud ZIP SHA-256 does not match manifest.json');

	const appId = requireTargetAppId();
	const client = new SquareCloudClient(process.env.SQUARECLOUD_API_KEY);
	const inspection = await inspectSquareCloud({ client, appId, includeMetrics: false });
	appUrl = inspection.appUrl;
	const environment = runtimeEnvironmentReport(inspection.envs);
	if (environment.requirements.length) {
		throw new Error(`Production runtime environment is incomplete or incompatible: ${environment.requirements.join(', ')}`);
	}

	console.log('Pre-deploy checks passed: target, runtime variables, HTTP binding, app status, and package.');
	snapshot = await createPreDeploySnapshot(client, appId);
	console.log(`Pre-deploy Square Cloud snapshot ready: ${snapshot.name}`);

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
	if (!startup) throw new Error('Squared startup log was not available after the application became reachable');
	if (Number(startup.nodeVersion.split('.')[0]) !== 24) {
		throw new Error(`Square Cloud started Squared on Node ${startup.nodeVersion}; Node.js 24 is required`);
	}

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
		['Runtime', `Squared ${manifest.version}; Node ${startup.nodeVersion}; ${startup.host}:${startup.port}`],
		['Profile', '1024 MB reserved; PostgreSQL external'],
		['Artifact', `${zipBytes} bytes; SHA-256 ${manifest.sha256}`],
		['Pre-deploy snapshot', `${snapshot.name} (${snapshot.versionId})`],
		['Readiness time', `${(ready.readyAt - deploymentStartedAt) / 1000}s from start/restart request`],
		['Health/editor/auth', 'healthz, readiness, editor and Bearer authentication passed'],
		['Production smoke', 'PostgreSQL-backed create/read, manual execution, webhook, persistence readback and cleanup passed'],
		['Memory at rest', idleStatus.ram || 'not reported by status endpoint'],
		['CPU at rest', idleStatus.cpu || 'not reported by status endpoint'],
		['Startup peak memory', summarizePeak(startupSamples, 'ram')],
		['Workflow CPU/RAM sample', summarizeResources(runSamples)],
		['Latest post-deploy metric', metricsLatest ? `${metricsLatest.date}: CPU ${metricsLatest.cpu}%, RAM ${metricsLatest.ram} MB` : 'no fresh five-minute metric sample available'],
		['Application status/uptime', `${postStatus.status || 'unknown'}; ${postStatus.uptime ?? 'uptime not reported'}`],
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

async function waitForReadiness({ client, appId, appUrl, startedAt, expectedProduct = 'squared' }) {
	const deadline = Date.now() + 180_000;
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
	if (!readyAt) throw new Error('Square Cloud application did not reach /healthz/readiness within 180 seconds');
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

async function runProductionSmoke({ client, appId, appUrl, accessToken }) {
	throwIfNoRuntimeToken(accessToken);
	const samplesDuringExecution = [];
	const apiUrl = (path) => new URL(path, appUrl);
	const api = (path, options = {}) => fetch(apiUrl(path), {
		...options,
		headers: {
			...(options.body ? { 'content-type': 'application/json' } : {}),
			authorization: `Bearer ${accessToken}`,
			...options.headers,
		},
		signal: AbortSignal.timeout(15_000),
	});

	const root = await fetch(appUrl, { signal: AbortSignal.timeout(15_000) });
	if (!root.ok || !(await root.text()).includes('<title>Squared</title>')) throw new Error('Production editor page was not served');
	const unauthenticated = await fetch(apiUrl('/api/workflows'), { signal: AbortSignal.timeout(15_000) });
	if (unauthenticated.status !== 401) throw new Error('Production workflow API did not enforce Bearer authentication');
	const authenticated = await api('/api/workflows');
	if (!authenticated.ok || !Array.isArray(await authenticated.json())) throw new Error('Production workflow API did not accept its configured Bearer token');

	let manualWorkflowId;
	let webhookWorkflowId;
	let cleanupFailed = false;
	try {
		const manualName = `Tarefa 003 smoke manual ${randomUUID()}`;
		const manual = await postWorkflow(api, {
			name: manualName,
			active: false,
			nodes: [
				{ id: randomUUID(), type: 'trigger.manual', name: 'Manual', parameters: {} },
				{ id: randomUUID(), type: 'data.set', name: 'Set', parameters: { values: { message: 'tarefa-003-smoke', run: '={{ $execution.id }}' } } },
			],
		});
		manualWorkflowId = manual.id;
		const persistedManual = await api(`/api/workflows/${encodeURIComponent(manualWorkflowId)}`);
		if (!persistedManual.ok || (await persistedManual.json()).name !== manualName) {
			throw new Error('Production PostgreSQL workflow create/read persistence check failed');
		}

		const manualRun = await api(`/api/workflows/${encodeURIComponent(manualWorkflowId)}/run`, {
			method: 'POST', body: JSON.stringify({ input: { source: 'tarefa-003-smoke' } }),
		});
		if (manualRun.status !== 202) throw new Error(`Manual production workflow returned HTTP ${manualRun.status}`);
		const manualExecutionId = (await manualRun.json()).id;
		const manualExecution = await waitForExecution(api, client, appId, manualExecutionId, samplesDuringExecution);
		if (manualExecution.status !== 'succeeded' || manualExecution.output?.message !== 'tarefa-003-smoke' || manualExecution.output?.source !== 'tarefa-003-smoke') {
			throw new Error('Production manual workflow execution did not return the expected output');
		}

		const webhookName = `Tarefa 003 smoke webhook ${randomUUID()}`;
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
			method: 'POST', body: JSON.stringify({ message: 'tarefa-003-webhook-smoke' }),
		});
		if (webhookRun.status !== 202) throw new Error(`Production webhook returned HTTP ${webhookRun.status}`);
		const webhookExecutionId = (await webhookRun.json()).id;
		const webhookExecution = await waitForExecution(api, client, appId, webhookExecutionId, samplesDuringExecution);
		if (webhookExecution.status !== 'succeeded' || webhookExecution.output?.echoed !== 'tarefa-003-webhook-smoke') {
			throw new Error('Production webhook workflow execution did not return the expected output');
		}
	} finally {
		for (const workflowId of [webhookWorkflowId, manualWorkflowId].filter(Boolean)) {
			try {
				const deleted = await api(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
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

function latestSample(samples) {
	return [...samples].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
}

function countRuntimeErrors(logs) {
	return logs.split(/\r?\n/).filter((line) => /\b(error|fatal|uncaught)\b/i.test(line)).length;
}

function throwIfNoRuntimeToken(value) {
	if (!value) throw new Error('The application has no readable SQUARED_ACCESS_TOKEN for the production smoke test');
}

function safeError(error) {
	if (error?.code && error?.status !== undefined) return `${error.code} (HTTP ${error.status})`;
	return error instanceof Error ? error.message : 'unknown error';
}
