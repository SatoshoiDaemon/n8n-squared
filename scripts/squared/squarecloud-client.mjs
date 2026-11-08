import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const TARGET_APP_ID = '59e2efa4975445339e8a6f7ad5295821';
const API_BASE = 'https://api.squarecloud.app/v2';

export class SquareCloudApiError extends Error {
	constructor(code, status) {
		super(`${code} (HTTP ${status})`);
		this.name = 'SquareCloudApiError';
		this.code = code;
		this.status = status;
	}
}

export class SquareCloudClient {
	constructor(apiKey) {
		if (!apiKey) throw new Error('Required GitHub Actions secret SQUARECLOUD_API_KEY is missing');
		this.apiKey = apiKey;
	}

	async get(path, { timeoutMs } = {}) {
		return this.request(path, { method: 'GET', timeoutMs });
	}

	async post(path, body, { timeoutMs, contentType } = {}) {
		return this.request(path, { method: 'POST', body, timeoutMs, contentType });
	}

	async request(path, { method, body, timeoutMs = 30_000, contentType } = {}) {
		const headers = new Headers({ Authorization: this.apiKey, Accept: 'application/json' });
		let requestBody = body;
		if (body !== undefined && !(body instanceof FormData)) {
			headers.set('Content-Type', contentType || 'application/json');
			requestBody = contentType === 'application/x-www-form-urlencoded' ? body : JSON.stringify(body);
		}

		let response;
		try {
			response = await fetch(`${API_BASE}${path}`, {
				method,
				headers,
				body: requestBody,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			const code = error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
			throw new SquareCloudApiError(code, 0);
		}

		let payload;
		try {
			payload = await response.json();
		} catch {
			throw new SquareCloudApiError('INVALID_RESPONSE', response.status);
		}
		if (!response.ok || payload?.status === 'error') {
			throw new SquareCloudApiError(payload?.code || `HTTP_${response.status}`, response.status);
		}
		if (payload?.status !== 'success') throw new SquareCloudApiError('INVALID_RESPONSE', response.status);
		return payload.response;
	}
}

export function requireTargetAppId(value = process.env.SQUARECLOUD_APP_ID) {
	if (!value) throw new Error('Required Square Cloud application ID is missing');
	if (value !== TARGET_APP_ID) throw new Error('SQUARECLOUD_APP_ID does not match the configured production application');
	return value;
}

export async function inspectSquareCloud({ client, appId, includeMetrics = true }) {
	const metricsRequest = includeMetrics
		? optionalRequest(() => client.get(`/apps/${encodeURIComponent(appId)}/metrics?range=24h`))
		: Promise.resolve(null);
	const [statusResult, envsResult, accountResult, logs, metrics] = await Promise.all([
		requiredProbe('GET /v2/apps/{app_id}/status', () => client.get(`/apps/${encodeURIComponent(appId)}/status`)),
		requiredProbe('GET /v2/apps/{app_id}/envs', () => client.get(`/apps/${encodeURIComponent(appId)}/envs`)),
		requiredProbe('GET /v2/users/me', () => client.get('/users/me')),
		optionalRequest(() => client.get(`/apps/${encodeURIComponent(appId)}/logs`)),
		metricsRequest,
	]);
	const accessFailures = [statusResult, envsResult, accountResult]
		.filter((result) => result.error)
		.map((result) => `${result.route} returned ${result.error}`);
	const appStatus = statusResult.value || null;
	const envs = envsResult.value || {};
	const account = accountResult.value || null;

	const application = (account?.applications || []).find((candidate) => candidate.id === appId) || null;
	if (account && !application) accessFailures.push('GET /v2/users/me did not return the configured application');
	const domain = application?.domain || application?.custom;
	const appUrl = typeof domain === 'string' && domain.length > 0
		? domain.startsWith('https://') || domain.startsWith('http://') ? new URL(domain).origin : `https://${domain}`
		: null;
	if (account && application && !appUrl) accessFailures.push('GET /v2/users/me did not return an application domain');
	const normalizedEnvs = envs && typeof envs === 'object' && !Array.isArray(envs) ? envs : {};
	return {
		appId,
		application,
		appUrl,
		appStatus: appStatus || {},
		envs: normalizedEnvs,
		accessFailures,
		logsAvailable: logs !== null,
		metricsAvailable: Array.isArray(metrics),
		logs: logs?.logs || '',
		metrics: Array.isArray(metrics) ? metrics : [],
	};
}

export function runtimeEnvironmentReport(envs) {
	const databaseValue = nonEmpty(envs.SQUARED_DATABASE_URL) ? envs.SQUARED_DATABASE_URL : envs.DATABASE_URL;
	const databaseName = nonEmpty(envs.SQUARED_DATABASE_URL) ? 'SQUARED_DATABASE_URL' : 'DATABASE_URL';
	const requirements = [];
	if (nonEmpty(databaseValue) && !isPostgresUrl(databaseValue)) {
		requirements.push(`${databaseName} must be a PostgreSQL URL when configured`);
	}
	if (nonEmpty(envs.SQUARED_ENCRYPTION_KEY) && envs.SQUARED_ENCRYPTION_KEY.length < 32) {
		requirements.push('SQUARED_ENCRYPTION_KEY must contain at least 32 characters when configured');
	}
	if (nonEmpty(envs.SQUARED_ACCESS_TOKEN) && envs.SQUARED_ACCESS_TOKEN.length < 24) {
		requirements.push('SQUARED_ACCESS_TOKEN must contain at least 24 characters when configured');
	}
	if (nonEmpty(envs.SQUARED_DATA_DIR)) {
		const dataDirectory = resolve(envs.SQUARED_DATA_DIR);
		const relativeToTemp = relative(resolve(tmpdir()), dataDirectory);
		if (!isAbsolute(relativeToTemp) && (relativeToTemp === '' || (relativeToTemp !== '..' && !relativeToTemp.startsWith(`..${sep}`)))) {
			requirements.push('SQUARED_DATA_DIR cannot be inside the operating system temporary directory');
		}
	}
	for (const name of ['SQUARED_PORT', 'PORT']) {
		if (nonEmpty(envs[name]) && Number(envs[name]) !== 80) requirements.push(`${name} must be unset or 80`);
	}
	if (nonEmpty(envs.SQUARED_HOST) && envs.SQUARED_HOST !== '0.0.0.0') {
		requirements.push('SQUARED_HOST must be unset or 0.0.0.0');
	}
	return {
		databaseVariable: nonEmpty(databaseValue) ? databaseName : null,
		databaseBackend: nonEmpty(databaseValue) ? 'PostgreSQL' : 'SQLite on persistent application storage',
		encryptionKeyOverridePresent: nonEmpty(envs.SQUARED_ENCRYPTION_KEY),
		accessTokenPresent: nonEmpty(envs.SQUARED_ACCESS_TOKEN),
		portCompatible: !requirements.some((item) => item.includes('PORT')),
		hostCompatible: !requirements.includes('SQUARED_HOST must be unset or 0.0.0.0'),
		requirements,
	};
}

export function appIsRunning(status) {
	if (typeof status?.running === 'boolean') return status.running;
	return /^(running|online|started)$/i.test(String(status?.status || ''));
}

export async function optionalRequest(request) {
	try {
		return await request();
	} catch {
		return null;
	}
}

async function requiredProbe(route, request) {
	try {
		return { route, value: await request(), error: null };
	} catch (error) {
		const detail = error?.code && error?.status !== undefined ? `${error.code} (HTTP ${error.status})` : 'request failed';
		return { route, value: null, error: detail };
	}
}

export function writeActionSummary(title, rows) {
	const content = [`## ${title}`, '', ...rows.map(([label, value]) => `- **${label}:** ${value}`), ''].join('\n');
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, content);
	}
	console.log(content.trimEnd());
}

function nonEmpty(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function isPostgresUrl(value) {
	try {
		const url = new URL(value);
		return ['postgres:', 'postgresql:'].includes(url.protocol);
	} catch {
		return false;
	}
}
