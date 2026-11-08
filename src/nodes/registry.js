import { runHttpRequest } from './http-request.js';
import { runIfNode } from './if.js';
import { runSetNode } from './set.js';

export function createNodeRegistry(services) {
	return new Map([
		['data.set', (input, parameters, context) => runSetNode(input, parameters, context)],
		['logic.if', (input, parameters, context) => runIfNode(input, parameters, context)],
		['http.request', (input, parameters, context) => runHttpRequest(input, parameters, context, services)],
	]);
}
