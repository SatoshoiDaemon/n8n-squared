import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { clearSessionCookie, sessionCookie, sessionTokenFromRequest } from '../auth/service.js';
import { RequestError } from '../errors.js';

const assets = new URL('../assets/', import.meta.url);

export function createHttpServer({ config, store, workflows, vault, auth, n8nNodeRuntime }) {
	const authAttempts = new Map();
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
			if (url.pathname === '/healthz' || url.pathname === '/healthz/readiness') {
				return sendJson(response, 200, { status: 'ok', product: 'squared', version: config.version || 'unknown' });
			}
			if (request.method === 'GET' && url.pathname === '/') return sendAsset(response, 'index.html', 'text/html; charset=utf-8');
			if (request.method === 'GET' && url.pathname === '/app.js') return sendAsset(response, 'app.js', 'text/javascript; charset=utf-8');
			if (request.method === 'GET' && url.pathname === '/styles.css') return sendAsset(response, 'styles.css', 'text/css; charset=utf-8');
			if (['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
				const registeredWebhook = workflows.resolveWebhook?.(request.method, url.pathname);
				if (registeredWebhook) {
					const webhookRequest = await readWebhookRequest(request, url, config.maxRequestBytes);
					webhookRequest.params = registeredWebhook.params;
					if (!(await workflows.authorizeWebhook?.(registeredWebhook, webhookRequest))) {
						return sendJson(response, 401, { error: 'Webhook authentication failed' });
					}
					const result = await workflows.execute(
						registeredWebhook.workflowId,
						'webhook',
						webhookRequest.body,
						{ webhookRequest, webhookNodeName: registeredWebhook.nodeName },
					);
					if (result.noExecution && result.capturedResponse?.ended) {
						return sendCapturedWebhookResponse(response, result.capturedResponse, request.method);
					}
					if (result.webhookResponse !== undefined) {
						return sendWebhookResponse(response, result.capturedResponse, result.webhookResponse, request.method);
					}
					return sendJson(response, 202, { id: result.id, status: result.status });
				}
			}

			if (request.method === 'GET' && url.pathname === '/api/auth/status') {
				return sendJson(response, 200, await auth.status(sessionTokenFromRequest(request)));
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
				ensureSameOrigin(request);
				if (!allowAuthAttempt(request, authAttempts)) return sendJson(response, 429, { error: 'Too many authentication attempts; try again later' });
				const body = await readJson(request, config.maxRequestBytes);
				const session = await auth.bootstrap(body);
				clearAuthAttempts(request, authAttempts);
				return sendJson(response, 201, { email: session.email }, { 'set-cookie': sessionCookie(session.sessionToken) });
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/login') {
				ensureSameOrigin(request);
				if (!allowAuthAttempt(request, authAttempts)) return sendJson(response, 429, { error: 'Too many authentication attempts; try again later' });
				const body = await readJson(request, config.maxRequestBytes);
				const session = await auth.login(body);
				clearAuthAttempts(request, authAttempts);
				return sendJson(response, 200, { email: session.email }, { 'set-cookie': sessionCookie(session.sessionToken) });
			}
			if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
				ensureSameOrigin(request);
				const sessionToken = sessionTokenFromRequest(request);
				if (!(await auth.status(sessionToken)).authenticated) return sendJson(response, 401, { error: 'Authentication required' });
				await auth.logout(sessionToken);
				return sendJson(response, 204, null, { 'set-cookie': clearSessionCookie() });
			}

			const sessionToken = sessionTokenFromRequest(request);
			const authenticatedBySession = (await auth.status(sessionToken)).authenticated;
			const authenticatedByToken = authorized(request.headers.authorization, config.accessToken);
			if (!authenticatedBySession && !authenticatedByToken) return sendJson(response, 401, { error: 'Authentication required' });
			if (authenticatedBySession && isMutation(request.method)) ensureSameOrigin(request);
			if (request.method === 'GET' && url.pathname === '/api/node-types') {
				const catalog = n8nNodeRuntime?.getSnapshot();
				return sendJson(response, 200, catalog ?? { packages: [], nodes: [], credentials: [] });
			}
			const nodeDescriptionMatch = url.pathname.match(/^\/api\/node-types\/(.+)\/description$/);
			if (nodeDescriptionMatch && request.method === 'GET') {
				if (!n8nNodeRuntime) throw httpError(404, 'n8n node packages are not configured');
				return sendJson(response, 200, await n8nNodeRuntime.loadDescription(decodeURIComponent(nodeDescriptionMatch[1])));
			}

			if (request.method === 'GET' && url.pathname === '/api/workflows') {
				return sendJson(response, 200, await workflows.list());
			}
			if (request.method === 'POST' && url.pathname === '/api/workflows') {
				const body = await readJson(request, config.maxRequestBytes);
				return sendJson(response, 201, await workflows.save(body));
			}
			if (request.method === 'POST' && url.pathname === '/api/workflows/import') {
				const body = await readJson(request, config.maxRequestBytes);
				return sendJson(response, 201, await workflows.importN8nWorkflow(body));
			}
			const workflowActivationMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/(activate|deactivate)$/);
			if (workflowActivationMatch && request.method === 'POST') {
				return sendJson(response, 200, await workflows.setActive(
					decodeURIComponent(workflowActivationMatch[1]),
					workflowActivationMatch[2] === 'activate',
				));
			}
			const workflowExportMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/export$/);
			if (workflowExportMatch && request.method === 'GET') {
				return sendJson(response, 200, await workflows.exportN8nWorkflow(decodeURIComponent(workflowExportMatch[1])));
			}
			const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
			if (workflowMatch && request.method === 'GET') {
				return sendJson(response, 200, await workflows.get(decodeURIComponent(workflowMatch[1])));
			}
			if (workflowMatch && request.method === 'PUT') {
				const body = await readJson(request, config.maxRequestBytes);
				return sendJson(response, 200, await workflows.save(body, decodeURIComponent(workflowMatch[1])));
			}
			if (workflowMatch && request.method === 'DELETE') {
				await workflows.remove(decodeURIComponent(workflowMatch[1]));
				return sendJson(response, 204, null);
			}
			const executeMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
			if (executeMatch && request.method === 'POST') {
				const body = await readJson(request, config.maxRequestBytes);
				return sendJson(
					response,
					202,
					await workflows.execute(decodeURIComponent(executeMatch[1]), 'manual', body.input ?? {}),
				);
			}
			const webhookMatch = url.pathname.match(/^\/webhook\/([^/]+)$/);
			if (webhookMatch && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
				const webhookRequest = await readWebhookRequest(request, url, config.maxRequestBytes);
				const result = await workflows.execute(
					decodeURIComponent(webhookMatch[1]),
					'webhook',
					webhookRequest.body,
					{ webhookRequest },
				);
				if (result.noExecution && result.capturedResponse?.ended) {
					return sendCapturedWebhookResponse(response, result.capturedResponse);
				}
				if (result.webhookResponse !== undefined) {
					return sendWebhookResponse(response, result.capturedResponse, result.webhookResponse);
				}
				return sendJson(response, 202, { id: result.id, status: result.status });
			}
			if (request.method === 'GET' && url.pathname === '/api/executions') {
				const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
				return sendJson(response, 200, await store.listExecutions(limit));
			}
			const resumeMatch = url.pathname.match(/^\/api\/executions\/([^/]+)\/resume$/);
			if (resumeMatch && request.method === 'POST') {
				const body = await readJson(request, config.maxRequestBytes);
				return sendJson(response, 202, await workflows.resumeExecution(decodeURIComponent(resumeMatch[1]), body.input));
			}
			const executionMatch = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
			if (executionMatch && request.method === 'GET') {
				const execution = await store.getExecution(decodeURIComponent(executionMatch[1]));
				if (!execution) throw httpError(404, 'Execution not found');
				return sendJson(response, 200, execution);
			}
			if (executionMatch && request.method === 'DELETE') {
				const removed = await store.deleteExecution(decodeURIComponent(executionMatch[1]));
				if (!removed) throw httpError(404, 'Execution not found');
				return sendJson(response, 204, null);
			}
			if (request.method === 'GET' && url.pathname === '/api/credentials') {
				return sendJson(response, 200, await store.listCredentials());
			}
			if (request.method === 'POST' && url.pathname === '/api/credentials') {
				const body = await readJson(request, config.maxRequestBytes);
				const name = typeof body.name === 'string' ? body.name.trim() : '';
				if (!name || name.length > 120) throw httpError(400, 'Credential name must contain 1 to 120 characters');
				if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
					throw httpError(400, 'Credential values must be a JSON object');
				}
				const id = randomUUID();
				await store.createCredential({ id, name, encryptedValue: vault.seal(body.values) });
				return sendJson(response, 201, { id, name });
			}
			const credentialMatch = url.pathname.match(/^\/api\/credentials\/([^/]+)$/);
			if (credentialMatch && request.method === 'DELETE') {
				const removed = await store.deleteCredential(decodeURIComponent(credentialMatch[1]));
				if (!removed) throw httpError(404, 'Credential not found');
				return sendJson(response, 204, null);
			}
			return sendJson(response, 404, { error: 'Not found' });
		} catch (error) {
			if (response.headersSent) {
				response.destroy(error);
				return;
			}
			const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
			if (status >= 500) console.error('Request failed', error?.name || 'Error', error?.code || 'unknown');
			sendJson(response, status, { error: status >= 500 ? 'Internal server error' : error.message });
		}
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 35_000;
	return server;
}

function authorized(header, expected) {
	if (!expected) return false;
	const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
	const actual = Buffer.from(supplied);
	const token = Buffer.from(expected);
	return actual.length === token.length && timingSafeEqual(actual, token);
}

function isMutation(method) {
	return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function ensureSameOrigin(request) {
	if (request.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, 'Cross-origin request rejected');
	const origin = request.headers.origin;
	if (!origin) return;
	try {
		if (new URL(origin).host !== request.headers.host) throw httpError(403, 'Cross-origin request rejected');
	} catch (error) {
		if (error instanceof RequestError) throw error;
		throw httpError(403, 'Cross-origin request rejected');
	}
}

function authAttemptKey(request) {
	const clientAddress = request.headers['cf-connecting-ip'] || request.socket.remoteAddress || 'unknown';
	return String(clientAddress).slice(0, 96);
}

function allowAuthAttempt(request, attempts) {
	const now = Date.now();
	const key = authAttemptKey(request);
	for (const [candidate, entry] of attempts) {
		if (entry.resetAt <= now) attempts.delete(candidate);
	}
	if (!attempts.has(key) && attempts.size >= 5_000) {
		const oldest = attempts.keys().next().value;
		if (oldest !== undefined) attempts.delete(oldest);
	}
	const current = attempts.get(key);
	if (current && current.count >= 8) return false;
	attempts.set(key, current && current.resetAt > now
		? { count: current.count + 1, resetAt: current.resetAt }
		: { count: 1, resetAt: now + 15 * 60 * 1000 });
	return true;
}

function clearAuthAttempts(request, attempts) {
	attempts.delete(authAttemptKey(request));
}

async function readJson(request, maxBytes) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw httpError(413, 'Request body exceeded the 1 MB limit');
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readWebhookRequest(request, url, maxBytes) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw httpError(413, 'Webhook body exceeded the 1 MB limit');
		chunks.push(chunk);
	}
	const rawBody = Buffer.concat(chunks);
	const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
	let body = {};
	if (rawBody.length) {
		const text = rawBody.toString('utf8');
		if (contentType.includes('json')) body = JSON.parse(text);
		else if (contentType.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(text));
		else body = text;
	}
	const query = {};
	for (const key of url.searchParams.keys()) {
		const values = url.searchParams.getAll(key);
		query[key] = values.length > 1 ? values : values[0];
	}
	return {
		method: request.method,
		url: url.href,
		path: url.pathname,
		headers: request.headers,
		query,
		body,
		params: {},
		rawBody,
		contentType: request.headers['content-type'] ?? '',
		ip: request.socket.remoteAddress,
		ips: request.socket.remoteAddress ? [request.socket.remoteAddress] : [],
		readRawBody: async () => rawBody,
	};
}

async function sendAsset(response, name, contentType) {
	const body = await readFile(fileURLToPath(new URL(name, assets)));
	response.writeHead(200, {
		'content-type': contentType,
		'cache-control': 'no-cache',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
	});
	response.end(body);
}

function sendJson(response, status, body, headers = {}) {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		...headers,
	});
	response.end(status === 204 ? undefined : JSON.stringify(body));
}

		function sendCapturedWebhookResponse(response, captured, method) {
	const status = Number(captured.statusCode) || 200;
	const headers = captured.headers && typeof captured.headers === 'object' ? captured.headers : {};
	const body = captured.body;
	response.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
	response.end(method === 'HEAD' ? undefined : body);
}

function sendWebhookResponse(response, captured, body, method) {
	const status = Number(captured?.statusCode) || 200;
	const capturedHeaders = captured?.headers && typeof captured.headers === 'object' ? captured.headers : {};
	const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...capturedHeaders };
	let output = body;
	if (Buffer.isBuffer(body) || body instanceof Uint8Array) output = Buffer.from(body);
	else if (body !== null && typeof body === 'object') {
		headers['content-type'] ??= 'application/json; charset=utf-8';
		output = JSON.stringify(body);
	} else {
		headers['content-type'] ??= 'text/plain; charset=utf-8';
		output = String(body ?? '');
	}
	response.writeHead(status, headers);
	response.end(method === 'HEAD' ? undefined : output);
}

function httpError(statusCode, message) {
	return new RequestError(statusCode, message);
}
