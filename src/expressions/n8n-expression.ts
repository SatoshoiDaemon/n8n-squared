export interface ExpressionItem {
	json: Record<string, unknown>;
	binary?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface N8nExpressionContext {
	item: ExpressionItem;
	inputItems?: ExpressionItem[];
	priorNodeItems?: Record<string, ExpressionItem[]>;
	execution?: Record<string, unknown>;
	workflow?: Record<string, unknown>;
	credentials?: Record<string, unknown>;
	additional?: Record<string, unknown>;
	clock?: () => Date;
}

type Token = { kind: 'identifier' | 'number' | 'string' | 'operator' | 'eof'; value: string; offset: number };
type ExpressionNode =
	| { kind: 'literal'; value: unknown }
	| { kind: 'identifier'; name: string }
	| { kind: 'array'; values: ExpressionNode[] }
	| { kind: 'object'; values: Array<[string, ExpressionNode]> }
	| { kind: 'member'; object: ExpressionNode; key: ExpressionNode; optional: boolean }
	| { kind: 'call'; callee: ExpressionNode; args: ExpressionNode[] }
	| { kind: 'unary'; operator: string; value: ExpressionNode }
	| { kind: 'binary'; operator: string; left: ExpressionNode; right: ExpressionNode }
	| { kind: 'conditional'; test: ExpressionNode; yes: ExpressionNode; no: ExpressionNode };

const precedence: Record<string, number> = {
	'??': 1,
	'||': 2,
	'&&': 3,
	'==': 4,
	'!=': 4,
	'===': 4,
	'!==': 4,
	'>': 5,
	'>=': 5,
	'<': 5,
	'<=': 5,
	'+': 6,
	'-': 6,
	'*': 7,
	'/': 7,
	'%': 7,
	'**': 8,
};

const deniedProperties = new Set([
	'__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__',
	'__lookupGetter__', '__lookupSetter__',
]);
const stringMethods = new Set([
	'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'split', 'includes',
	'startsWith', 'endsWith', 'slice', 'substring', 'padStart', 'padEnd',
]);
const arrayMethods = new Set(['includes', 'join', 'slice', 'indexOf', 'lastIndexOf', 'at', 'concat']);

/** Evaluate the safe expression subset used by workflow parameter contexts. */
export function evaluateN8nExpression(value: unknown, context: N8nExpressionContext): unknown {
	if (typeof value !== 'string') return value;
	const source = value.startsWith('=') ? value.slice(1) : value;
	const full = source.match(/^\s*\{\{([\s\S]*)\}\}\s*$/);
	if (full) return evaluateSource(full[1] ?? '', context);

	return source.replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
		const result = evaluateSource(expression, context);
		if (result === undefined || result === null) return '';
		return typeof result === 'string' ? result : JSON.stringify(result);
	});
}

export function resolveParameterTree(value: unknown, context: N8nExpressionContext): unknown {
	if (typeof value === 'string') return evaluateN8nExpression(value, context);
	if (Array.isArray(value)) return value.map((item) => resolveParameterTree(item, context));
	if (!isPlainObject(value)) return value;
	const resolved: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (deniedProperties.has(key)) throw new Error(`Unsafe workflow parameter key: ${key}`);
		resolved[key] = resolveParameterTree(item, context);
	}
	return resolved;
}

function evaluateSource(source: string, context: N8nExpressionContext): unknown {
	const parser = new Parser(tokenize(source));
	const expression = parser.parse();
	return evaluateAst(expression, context);
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let offset = 0;
	while (offset < source.length) {
		const char = source[offset] ?? '';
		if (/\s/.test(char)) { offset += 1; continue; }
		const start = offset;
		if (/[A-Za-z_$]/.test(char)) {
			offset += 1;
			while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset] ?? '')) offset += 1;
			tokens.push({ kind: 'identifier', value: source.slice(start, offset), offset: start });
			continue;
		}
		if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[offset + 1] ?? ''))) {
			const match = source.slice(offset).match(/^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/);
			if (!match) throw syntaxError(source, start, 'Invalid number');
			offset += match[0].length;
			tokens.push({ kind: 'number', value: match[0], offset: start });
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = char;
			offset += 1;
			let value = '';
			while (offset < source.length && source[offset] !== quote) {
				const current = source[offset] ?? '';
				if (current === '\\') {
					offset += 1;
					const escaped = source[offset];
					if (escaped === undefined) throw syntaxError(source, start, 'Unterminated string');
					const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'" };
					value += escapes[escaped] ?? escaped;
					offset += 1;
				} else {
					value += current;
					offset += 1;
				}
			}
			if (source[offset] !== quote) throw syntaxError(source, start, 'Unterminated string');
			offset += 1;
			tokens.push({ kind: 'string', value, offset: start });
			continue;
		}
		const operator = ['===', '!==', '?.', '??', '&&', '||', '==', '!=', '>=', '<=', '**']
			.find((candidate) => source.startsWith(candidate, offset));
		if (operator) {
			tokens.push({ kind: 'operator', value: operator, offset });
			offset += operator.length;
			continue;
		}
		if ('+-*/%><!?:.,()[]{}'.includes(char)) {
			tokens.push({ kind: 'operator', value: char, offset });
			offset += 1;
			continue;
		}
		throw syntaxError(source, offset, `Unsupported character ${JSON.stringify(char)}`);
	}
	tokens.push({ kind: 'eof', value: '', offset: source.length });
	return tokens;
}

class Parser {
	private position = 0;
	private readonly tokens: Token[];
	constructor(tokens: Token[]) { this.tokens = tokens; }

	parse(): ExpressionNode {
		const expression = this.parseExpression(0);
		if (this.peek().kind !== 'eof') throw this.error('Unexpected token');
		return expression;
	}

	private parseExpression(minimum: number): ExpressionNode {
		let left = this.parsePrefix();
		left = this.parsePostfix(left);
		while (true) {
			const token = this.peek();
			if (token.value === '?' && minimum <= 0) {
				this.take();
				const yes = this.parseExpression(0);
				this.expect(':');
				const no = this.parseExpression(0);
				left = { kind: 'conditional', test: left, yes, no };
				continue;
			}
			const level = precedence[token.value];
			if (level === undefined || level < minimum) break;
			this.take();
			const rightMinimum = token.value === '**' ? level : level + 1;
			left = { kind: 'binary', operator: token.value, left, right: this.parseExpression(rightMinimum) };
		}
		return left;
	}

	private parsePrefix(): ExpressionNode {
		const token = this.take();
		if (token.kind === 'number') return { kind: 'literal', value: Number(token.value) };
		if (token.kind === 'string') return { kind: 'literal', value: token.value };
		if (token.kind === 'identifier') {
			if (token.value === 'true') return { kind: 'literal', value: true };
			if (token.value === 'false') return { kind: 'literal', value: false };
			if (token.value === 'null') return { kind: 'literal', value: null };
			if (token.value === 'undefined') return { kind: 'literal', value: undefined };
			return { kind: 'identifier', name: token.value };
		}
		if (['!', '+', '-'].includes(token.value)) {
			return { kind: 'unary', operator: token.value, value: this.parseExpression(9) };
		}
		if (token.value === '(') {
			const value = this.parseExpression(0);
			this.expect(')');
			return value;
		}
		if (token.value === '[') {
			const values: ExpressionNode[] = [];
			if (!this.match(']')) {
				do { values.push(this.parseExpression(0)); } while (this.match(','));
				this.expect(']');
			}
			return { kind: 'array', values };
		}
		if (token.value === '{') {
			const values: Array<[string, ExpressionNode]> = [];
			if (!this.match('}')) {
				do {
					const key = this.take();
					if (!['identifier', 'string', 'number'].includes(key.kind)) throw this.error('Invalid object key');
					if (deniedProperties.has(key.value)) throw this.error('Unsafe object key');
					this.expect(':');
					values.push([key.value, this.parseExpression(0)]);
				} while (this.match(','));
				this.expect('}');
			}
			return { kind: 'object', values };
		}
		throw this.error('Expected an expression');
	}

	private parsePostfix(initial: ExpressionNode): ExpressionNode {
		let value = initial;
		while (true) {
			if (this.match('.')) {
				const key = this.take();
				if (key.kind !== 'identifier' || deniedProperties.has(key.value)) throw this.error('Invalid property access');
				value = { kind: 'member', object: value, key: { kind: 'literal', value: key.value }, optional: false };
				continue;
			}
			if (this.match('?.')) {
				const key = this.take();
				if (key.kind !== 'identifier' || deniedProperties.has(key.value)) throw this.error('Invalid optional property access');
				value = { kind: 'member', object: value, key: { kind: 'literal', value: key.value }, optional: true };
				continue;
			}
			if (this.match('[')) {
				const key = this.parseExpression(0);
				this.expect(']');
				value = { kind: 'member', object: value, key, optional: false };
				continue;
			}
			if (this.match('(')) {
				const args: ExpressionNode[] = [];
				if (!this.match(')')) {
					do { args.push(this.parseExpression(0)); } while (this.match(','));
					this.expect(')');
				}
				value = { kind: 'call', callee: value, args };
				continue;
			}
			return value;
		}
	}

	private peek(): Token { return this.tokens[this.position] ?? { kind: 'eof', value: '', offset: 0 }; }
	private take(): Token { const token = this.peek(); this.position += 1; return token; }
	private match(value: string): boolean { if (this.peek().value !== value) return false; this.take(); return true; }
	private expect(value: string): void { if (!this.match(value)) throw this.error(`Expected ${value}`); }
	private error(message: string): Error { return new Error(`${message} at expression offset ${this.peek().offset}`); }
}

interface InputProxy {
	readonly kind: 'input-proxy';
	readonly items: ExpressionItem[];
}

interface SafeMethod {
	readonly kind: 'safe-method';
	readonly owner: unknown;
	readonly name: string;
}

function evaluateAst(node: ExpressionNode, context: N8nExpressionContext): unknown {
	switch (node.kind) {
		case 'literal': return node.value;
		case 'identifier': return resolveIdentifier(node.name, context);
		case 'array': return node.values.map((value) => evaluateAst(value, context));
		case 'object': {
			const object: Record<string, unknown> = {};
			for (const [key, value] of node.values) object[key] = evaluateAst(value, context);
			return object;
		}
		case 'member': {
			const object = evaluateAst(node.object, context);
			if ((object === null || object === undefined) && node.optional) return undefined;
			const key = evaluateAst(node.key, context);
			return resolveMember(object, key);
		}
		case 'call': return evaluateCall(node, context);
		case 'unary': {
			const value = evaluateAst(node.value, context);
			if (node.operator === '!') return !value;
			if (node.operator === '+') return Number(value);
			return -Number(value);
		}
		case 'conditional': return evaluateAst(node.test, context) ? evaluateAst(node.yes, context) : evaluateAst(node.no, context);
		case 'binary': return evaluateBinary(node, context);
	}
}

function evaluateBinary(node: Extract<ExpressionNode, { kind: 'binary' }>, context: N8nExpressionContext): unknown {
	const left = evaluateAst(node.left, context);
	if (node.operator === '&&') return left ? evaluateAst(node.right, context) : left;
	if (node.operator === '||') return left ? left : evaluateAst(node.right, context);
	if (node.operator === '??') return left === null || left === undefined ? evaluateAst(node.right, context) : left;
	const right = evaluateAst(node.right, context);
	switch (node.operator) {
		case '+': return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right);
		case '-': return Number(left) - Number(right);
		case '*': return Number(left) * Number(right);
		case '/': return Number(left) / Number(right);
		case '%': return Number(left) % Number(right);
		case '**': return Number(left) ** Number(right);
		case '==': return left == right;
		case '!=': return left != right;
		case '===': return left === right;
		case '!==': return left !== right;
		case '>': return (left as never) > (right as never);
		case '>=': return (left as never) >= (right as never);
		case '<': return (left as never) < (right as never);
		case '<=': return (left as never) <= (right as never);
		default: throw new Error(`Unsupported expression operator: ${node.operator}`);
	}
}

function evaluateCall(node: Extract<ExpressionNode, { kind: 'call' }>, context: N8nExpressionContext): unknown {
	const args = node.args.map((arg) => evaluateAst(arg, context));
	if (node.callee.kind === 'identifier') {
		if (node.callee.name === '$items') {
			const nodeName = args[0];
			if (typeof nodeName !== 'string') throw new Error('$items requires a node name');
			return context.priorNodeItems?.[nodeName] ?? [];
		}
		if (node.callee.name === '$ifEmpty') return args[0] === '' || args[0] === null || args[0] === undefined ? args[1] : args[0];
		if (node.callee.name === '$isEmpty') return isEmpty(args[0]);
		throw new Error(`Function ${node.callee.name} is not available in safe expressions`);
	}
	const callee = evaluateAst(node.callee, context);
	if (!isSafeMethod(callee)) throw new Error('Calling workflow values is not allowed');
	return callSafeMethod(callee, args);
}

function resolveIdentifier(name: string, context: N8nExpressionContext): unknown {
	if (Object.hasOwn(context.additional ?? {}, name)) return context.additional?.[name];
	switch (name) {
		case '$json': return context.item.json;
		case '$binary': return context.item.binary ?? {};
		case '$input': return { kind: 'input-proxy', items: context.inputItems ?? [] } satisfies InputProxy;
		case '$node': {
			const nodes: Record<string, unknown> = Object.create(null);
			for (const [nodeName, items] of Object.entries(context.priorNodeItems ?? {})) {
				nodes[nodeName] = items[0] ?? {};
			}
			return nodes;
		}
		case '$execution': return context.execution ?? {};
		case '$workflow': return context.workflow ?? {};
		case '$credentials': return context.credentials ?? {};
		case '$now': return (context.clock ?? (() => new Date()))().toISOString();
		default: throw new Error(`Unknown expression variable: ${name}`);
	}
}

function resolveMember(object: unknown, key: unknown): unknown {
	if (typeof key !== 'string' && typeof key !== 'number') throw new Error('Expression property key must be a string or number');
	const property = String(key);
	if (deniedProperties.has(property)) throw new Error(`Unsafe expression property: ${property}`);
	if (object === null || object === undefined) throw new Error(`Cannot read ${property} from an empty value`);
	if (typeof object === 'string') {
		if (property === 'length') return object.length;
		if (stringMethods.has(property)) return { kind: 'safe-method', owner: object, name: property } satisfies SafeMethod;
		if (/^(?:0|[1-9]\d*)$/.test(property)) return object[Number(property)];
	}
	if (Array.isArray(object)) {
		if (property === 'length') return object.length;
		if (arrayMethods.has(property)) return { kind: 'safe-method', owner: object, name: property } satisfies SafeMethod;
		if (/^(?:0|[1-9]\d*)$/.test(property)) return object[Number(property)];
	}
	if (isPlainObject(object) && Object.hasOwn(object, property)) return object[property];
	if (isInputProxy(object) && ['all', 'first', 'last'].includes(property)) {
		return { kind: 'safe-method', owner: object, name: property } satisfies SafeMethod;
	}
	return undefined;
}

function isSafeMethod(value: unknown): value is SafeMethod {
	return isPlainObject(value) && value.kind === 'safe-method' && typeof value.name === 'string';
}

function callSafeMethod(method: SafeMethod, args: unknown[]): unknown {
	if (typeof method.owner === 'string' && stringMethods.has(method.name)) {
		const owner = method.owner;
		switch (method.name) {
			case 'trim': return owner.trim();
			case 'trimStart': return owner.trimStart();
			case 'trimEnd': return owner.trimEnd();
			case 'toUpperCase': return owner.toUpperCase();
			case 'toLowerCase': return owner.toLowerCase();
			case 'split': return args[0] === undefined
				? owner.split(undefined as unknown as string)
				: owner.split(String(args[0]), args[1] === undefined ? undefined : Number(args[1]));
			case 'includes': return owner.includes(String(args[0]));
			case 'startsWith': return owner.startsWith(String(args[0]), args[1] === undefined ? 0 : Number(args[1]));
			case 'endsWith': return owner.endsWith(String(args[0]), args[1] === undefined ? owner.length : Number(args[1]));
			case 'slice': return args[1] === undefined ? owner.slice(Number(args[0] ?? 0)) : owner.slice(Number(args[0] ?? 0), Number(args[1]));
			case 'substring': return args[1] === undefined ? owner.substring(Number(args[0] ?? 0)) : owner.substring(Number(args[0] ?? 0), Number(args[1]));
			case 'padStart': return owner.padStart(Number(args[0]), args[1] === undefined ? ' ' : String(args[1]));
			case 'padEnd': return owner.padEnd(Number(args[0]), args[1] === undefined ? ' ' : String(args[1]));
		}
	}
	if (Array.isArray(method.owner) && arrayMethods.has(method.name)) {
		const owner = method.owner;
		switch (method.name) {
			case 'includes': return owner.includes(args[0]);
			case 'join': return owner.join(args[0] === undefined ? ',' : String(args[0]));
			case 'slice': return owner.slice(args[0] as number | undefined, args[1] as number | undefined);
			case 'indexOf': return owner.indexOf(args[0]);
			case 'lastIndexOf': return owner.lastIndexOf(args[0]);
			case 'at': return owner.at(Number(args[0]));
			case 'concat': return owner.concat(...args);
		}
	}
	if (isInputProxy(method.owner)) {
		if (method.name === 'all') return method.owner.items;
		if (method.name === 'first') return method.owner.items[0];
		if (method.name === 'last') return method.owner.items.at(-1);
	}
	throw new Error(`Method ${method.name} is not available in safe expressions`);
}

function isInputProxy(value: unknown): value is InputProxy {
	return isPlainObject(value) && value.kind === 'input-proxy' && Array.isArray(value.items);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isEmpty(value: unknown): boolean {
	return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) ||
		(isPlainObject(value) && Object.keys(value).length === 0);
}

function syntaxError(source: string, offset: number, message: string): Error {
	return new Error(`${message} at expression offset ${offset}`);
}
