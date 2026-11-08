import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RequestError } from '../errors.js';

const assets = new URL('../assets/', import.meta.url);

export function createHttpServer({ config, store, workflows, vault }) {
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
			if (url.pathname === '/healthz' || url.pathname === '/healthz/readiness') {
				return sendJson(response, 200, { status: 'ok', product: 'squared', version: config.version || 'unknown' });
			}
			if (request.method === 'GET' && url.pathname === '/') return sendAsset(response, 'index.html', 'text/html; charset=utf-8');
			if (request.method === 'GET' && url.pathname === '/app.js') return sendAsset(response, 'app.js', 'text/javascript; charset=utf-8');
			if (request.method === 'GET' && url.pathname === '/styles.css') return sendAsset(response, 'styles.css', 'text/css; charset=utf-8');
			if (!authorized(request.headers.authorization, config.accessToken)) {
				return sendJson(response, 401, { error: 'Enter the application access token to continue' });
			}

			if (request.method === 'GET' && url.pathname === '/api/workflows') {
				return sendJson(response, 200, await workflows.list());
			}
			if (request.method === 'POST' && url.pathname === '/api/workflows') {
				const body = await readJson(request, config.maxRequestBytes);
				return sendJson(response, 201, await workflows.save(body));
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
			if (webhookMatch && request.method === 'POST') {
				const input = await readJson(request, config.maxRequestBytes);
				return sendJson(response, 202, await workflows.execute(decodeURIComponent(webhookMatch[1]), 'webhook', input));
			}
			if (request.method === 'GET' && url.pathname === '/api/executions') {
				const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
				return sendJson(response, 200, await store.listExecutions(limit));
			}
			const executionMatch = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
			if (executionMatch && request.method === 'GET') {
				const execution = await store.getExecution(decodeURIComponent(executionMatch[1]));
				if (!execution) throw httpError(404, 'Execution not found');
				return sendJson(response, 200, execution);
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
			if (status >= 500) console.error('Request failed', error);
			sendJson(response, status, { error: status >= 500 ? 'Internal server error' : error.message });
		}
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 35_000;
	return server;
}

function authorized(header, expected) {
	const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
	const actual = Buffer.from(supplied);
	const token = Buffer.from(expected);
	return actual.length === token.length && timingSafeEqual(actual, token);
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

function sendJson(response, status, body) {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	response.end(status === 204 ? undefined : JSON.stringify(body));
}

function httpError(statusCode, message) {
	return new RequestError(statusCode, message);
}
