import { evaluateValue } from '../expressions/evaluate.js';

export async function runHttpRequest(input, parameters, context, services) {
	const method = String(parameters.method ?? 'GET').toUpperCase();
	if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
		throw new Error(`Unsupported HTTP method: ${method}`);
	}
	const url = evaluateValue(parameters.url, context);
	if (typeof url !== 'string') throw new Error('HTTP Request needs a URL');
	const parsedUrl = new URL(url);
	if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('HTTP Request URL must use http or https');
	const headers = new Headers();
	for (const [key, value] of Object.entries(parameters.headers ?? {})) {
		headers.set(key, String(evaluateValue(value, context)));
	}
	if (parameters.credentialId) {
		const credential = await services.getCredential(parameters.credentialId);
		if (!credential) throw new Error(`Credential not found: ${parameters.credentialId}`);
		for (const [key, value] of Object.entries(credential)) headers.set(key, String(value));
	}
	const body = ['GET', 'HEAD'].includes(method) || parameters.body === undefined
		? undefined
		: JSON.stringify(evaluateValue(parameters.body, context));
	if (body && Buffer.byteLength(body) > 1_048_576) throw new Error('HTTP request body exceeded the 1 MB limit');
	if (body && !headers.has('content-type')) headers.set('content-type', 'application/json');
	const timeoutMs = Number(parameters.timeoutMs ?? services.requestTimeoutMs);
	if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
		throw new Error('HTTP Request timeoutMs must be between 100 and 120000');
	}
	const response = await fetch(parsedUrl, {
		method,
		headers,
		body,
		signal: AbortSignal.timeout(timeoutMs),
		redirect: 'error',
	});
	const chunks = [];
	let responseLength = 0;
	if (response.body) {
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			responseLength += value.byteLength;
			if (responseLength > services.maxResponseBytes) {
				await reader.cancel();
				throw new Error('HTTP response exceeded the 5 MB limit');
			}
			chunks.push(value);
		}
	}
	const responseBytes = new Uint8Array(responseLength);
	let offset = 0;
	for (const chunk of chunks) {
		responseBytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(responseBytes);
	let responseBody = text;
	if (text && response.headers.get('content-type')?.includes('application/json')) {
		try {
			responseBody = JSON.parse(text);
		} catch {
			responseBody = text;
		}
	}
	return {
		statusCode: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		body: responseBody,
		request: { method, url: parsedUrl.toString() },
	};
}
