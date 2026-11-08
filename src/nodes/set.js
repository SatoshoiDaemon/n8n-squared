import { evaluateValue } from '../expressions/evaluate.js';

export function runSetNode(input, parameters, context) {
	const values = parameters.values ?? {};
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Set node values must be an object');
	const output = { ...input };
	for (const [key, value] of Object.entries(values)) {
		if (!key || key === '__proto__' || key === 'constructor') throw new Error(`Invalid Set node field: ${key}`);
		output[key] = evaluateValue(value, context);
	}
	return output;
}
