import { appendFileSync } from 'node:fs';

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
	if (!value) throw new Error('Required GitHub Actions secret SQUARECLOUD_APP_ID is missing');
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
	const requiredFailures = [statusResult, envsResult, accountResult].filter((result) => result.error);
	if (requiredFailures.length) {
		throw new Error(`Square Cloud API preflight access is incomplete: ${requiredFailures.map((result) => `${result.route} returned ${result.error}`).join('; ')}`);
	}
	const appStatus = statusResult.value;
	const envs = envsResult.value;
	const account = accountResult.value;

	const application = (account?.applications || []).find((candidate) => candidate.id === appId);
	if (!application) throw new Error('The configured Square Cloud application was not found in the authenticated account');
	const domain = application.domain || application.custom;
	if (typeof domain !== 'string' || domain.length === 0) {
		throw new Error('The configured application does not expose a domain for production health checks');
	}
	const appUrl = domain.startsWith('https://') || domain.startsWith('http://') ? new URL(domain).origin : `https://${domain}`;
	const normalizedEnvs = envs && typeof envs === 'object' && !Array.isArray(envs) ? envs : {};
	return {
		appId,
		application,
		appUrl,
		appStatus: appStatus || {},
		envs: normalizedEnvs,
		logs: logs?.logs || '',
		metrics: Array.isArray(metrics) ? metrics : [],
	};
}

export function runtimeEnvironmentReport(envs) {
	const databaseValue = nonEmpty(envs.SQUARED_DATABASE_URL) ? envs.SQUARED_DATABASE_URL : envs.DATABASE_URL;
	const databaseName = nonEmpty(envs.SQUARED_DATABASE_URL) ? 'SQUARED_DATABASE_URL' : 'DATABASE_URL';
	const requirements = [];
	if (!nonEmpty(databaseValue)) requirements.push('SQUARED_DATABASE_URL (or DATABASE_URL)');
	else if (!isExternalPostgresUrl(databaseValue)) requirements.push(`${databaseName} must be an external PostgreSQL URL`);
	if (!nonEmpty(envs.SQUARED_ENCRYPTION_KEY) || envs.SQUARED_ENCRYPTION_KEY.length < 32) {
		requirements.push('SQUARED_ENCRYPTION_KEY (at least 32 characters)');
	}
	if (!nonEmpty(envs.SQUARED_ACCESS_TOKEN) || envs.SQUARED_ACCESS_TOKEN.length < 24) {
		requirements.push('SQUARED_ACCESS_TOKEN (at least 24 characters)');
	}
	for (const name of ['SQUARED_PORT', 'PORT']) {
		if (nonEmpty(envs[name]) && Number(envs[name]) !== 80) requirements.push(`${name} must be unset or 80`);
	}
	if (nonEmpty(envs.SQUARED_HOST) && envs.SQUARED_HOST !== '0.0.0.0') {
		requirements.push('SQUARED_HOST must be unset or 0.0.0.0');
	}
	return {
		databaseVariable: nonEmpty(databaseValue) ? databaseName : null,
		encryptionKeyPresent: nonEmpty(envs.SQUARED_ENCRYPTION_KEY) && envs.SQUARED_ENCRYPTION_KEY.length >= 32,
		accessTokenPresent: nonEmpty(envs.SQUARED_ACCESS_TOKEN) && envs.SQUARED_ACCESS_TOKEN.length >= 24,
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

function isExternalPostgresUrl(value) {
	try {
		const url = new URL(value);
		return (
			['postgres:', 'postgresql:'].includes(url.protocol) &&
			!['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}
