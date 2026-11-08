const expressionPattern = /\{\{\s*([^{}]+?)\s*\}\}/g;

function resolve(expression, context) {
	const path = expression.trim();
	if (path === '$now') return new Date().toISOString();
	if (path === '$execution.id') return context.executionId;
	if (path === '$json') return context.json;
	if (!path.startsWith('$json.')) throw new Error(`Unsupported expression: ${path}`);
	const keys = path.slice(6).split('.');
	let value = context.json;
	for (const key of keys) {
		if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') {
			throw new Error(`Invalid expression path: ${path}`);
		}
		value = value == null ? undefined : value[key];
	}
	return value;
}
export function evaluateValue(value, context) {
	if (typeof value !== 'string') return value;
	const source = value.startsWith('=') ? value.slice(1) : value;
	const full = source.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
	if (full) return resolve(full[1], context);
	return source.replace(expressionPattern, (_match, expression) => {
		const result = resolve(expression, context);
		return result == null ? '' : typeof result === 'string' ? result : JSON.stringify(result);
	});
}
