import { evaluateValue } from '../expressions/evaluate.js';

export function runIfNode(input, parameters, context) {
	const left = evaluateValue(parameters.value, context);
	const right = evaluateValue(parameters.compareTo, context);
	switch (parameters.operation ?? 'isTrue') {
		case 'isTrue':
			return Boolean(left);
		case 'equals':
			return Object.is(left, right);
		case 'notEquals':
			return !Object.is(left, right);
		case 'greaterThan':
			return Number(left) > Number(right);
		case 'contains':
			return typeof left === 'string' ? left.includes(String(right)) : Array.isArray(left) && left.includes(right);
		case 'exists':
			return left !== undefined && left !== null;
		default:
			throw new Error(`Unsupported IF operation: ${String(parameters.operation)}`);
	}
}
