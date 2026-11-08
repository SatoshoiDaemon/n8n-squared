import { evaluateN8nExpression, resolveParameterTree, type ExpressionItem, type N8nExpressionContext } from '../expressions/n8n-expression.ts';
import { buildWorkflowGraph, type WorkflowConnection, type WorkflowDocument, type WorkflowGraph, type WorkflowNodeDocument } from '../workflows/n8n-format.ts';
import { extname } from 'node:path';

export interface NodeExecutionData extends ExpressionItem {
	json: Record<string, unknown>;
	binary?: Record<string, unknown>;
	pairedItem?: number | { item: number; input?: number } | Array<number | { item: number; input?: number }>;
	error?: { message: string; description?: string; [key: string]: unknown };
}

export type NodeOutput = NodeExecutionData[][] | Record<string, NodeExecutionData[][]> | null | undefined;

export interface GraphNodeContext {
	readonly executionId: string;
	readonly mode: 'manual' | 'webhook' | 'schedule' | 'trigger';
	readonly node: WorkflowNodeDocument;
	readonly workflow: WorkflowDocument;
	readonly signal: AbortSignal;
	getInputData(inputIndex?: number, connectionType?: string): NodeExecutionData[];
	getNodeParameter<T = unknown>(parameterName: string, itemIndex?: number, fallbackValue?: T, options?: NodeParameterOptions): T;
	evaluateExpression(expression: string, itemIndex?: number, fallbackValue?: unknown, throwOnMissing?: boolean): unknown;
	getNode(): WorkflowNodeDocument;
	getWorkflow(): WorkflowDocument;
	getMode(): GraphNodeContext['mode'];
	getExecutionId(): string;
	getTimezone(): string;
	getWorkflowSettings(): Record<string, unknown>;
	getWorkflowStaticData(type: string): Record<string, unknown>;
	continueOnFail(): boolean;
	getExecutionCancelSignal(): AbortSignal;
	getContext(type: 'flow' | 'node'): Record<string, unknown>;
	sendMessageToUI(...args: unknown[]): void;
	prepareOutputData<T extends NodeExecutionData[]>(items: T, inputIndex?: number): Promise<[T]>;
	readonly helpers: Record<string, (...args: any[]) => any>;
	readonly logger: Record<string, (...args: unknown[]) => void>;
	getCredentials(credentialType: string): Promise<Record<string, unknown>>;
}

export interface NodeParameterOptions {
	rawExpressions?: boolean;
	extractValue?: boolean;
	ensureType?: string;
	skipValidation?: boolean;
	[key: string]: unknown;
}

export interface NodeAdapter {
	type: string;
	/** Exact typeVersion values supported by this implementation. */
	versions: number[];
	execute(context: GraphNodeContext): Promise<NodeOutput>;
}

export interface CredentialProvider {
	(reference: { id?: string; name: string }, credentialType: string, node: WorkflowNodeDocument): Promise<Record<string, unknown> | null>;
}

export interface GraphEngineLimits {
	maxNodes?: number;
	maxItems?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface GraphExecutionRequest {
	input?: unknown;
	startNode?: string;
	executionId?: string;
	mode?: GraphNodeContext['mode'];
}

export interface NodeRunRecord {
	nodeId: string;
	nodeName: string;
	nodeType: string;
	typeVersion?: number;
	status: 'succeeded' | 'skipped' | 'failed' | 'continued';
	attempts: number;
	inputItems: number;
	outputItems: number;
	error?: string;
}

export interface GraphExecutionResult {
	id: string;
	workflowId?: string;
	status: 'succeeded' | 'failed';
	output: NodeExecutionData[];
	outputsByNode: Record<string, NodeExecutionData[][]>;
	nodeRuns: NodeRunRecord[];
	error?: string;
}

export class NodeAdapterRegistry {
	private readonly adapters = new Map<string, Map<number, NodeAdapter>>();
	private readonly loaders = new Map<string, () => Promise<NodeAdapter>>();
	private readonly pendingLoads = new Map<string, Promise<NodeAdapter>>();

	register(adapter: NodeAdapter): void {
		if (!adapter.type || adapter.versions.length === 0) throw new Error('Node adapters need a type and at least one version');
		const versions = this.adapters.get(adapter.type) ?? new Map<number, NodeAdapter>();
		for (const version of adapter.versions) {
			if (!Number.isFinite(version) || version <= 0) throw new Error(`Invalid adapter version for ${adapter.type}`);
			if (versions.has(version)) throw new Error(`Adapter already registered for ${adapter.type}@${version}`);
			versions.set(version, adapter);
		}
		this.adapters.set(adapter.type, versions);
		this.loaders.delete(adapter.type);
	}

	registerLazy(type: string, loader: () => Promise<NodeAdapter>): void {
		if (!type || typeof loader !== 'function') throw new Error('Lazy node adapters need a type and loader');
		if (this.loaders.has(type) || this.adapters.has(type)) throw new Error(`Adapter already registered for ${type}`);
		this.loaders.set(type, loader);
	}

	get(type: string, version: number): NodeAdapter | undefined {
		return this.adapters.get(type)?.get(version);
	}

	async resolve(type: string, version: number): Promise<NodeAdapter | undefined> {
		const existing = this.get(type, version);
		if (existing) return existing;
		const loader = this.loaders.get(type);
		if (!loader) return undefined;
		let pending = this.pendingLoads.get(type);
		if (!pending) {
			pending = loader();
			this.pendingLoads.set(type, pending);
		}
		try {
			const adapter = await pending;
			if (!this.adapters.has(type)) this.register(adapter);
			return this.get(type, version);
		} catch (error) {
			this.loaders.delete(type);
			throw error;
		} finally {
			this.pendingLoads.delete(type);
		}
	}

	versions(type: string): number[] {
		return [...(this.adapters.get(type)?.keys() ?? [])].sort((left, right) => left - right);
	}
}

/**
 * Experimental graph executor. It preserves n8n JSON and supports main-channel
 * directed acyclic graphs with multiple ports, joins, item data, error outputs,
 * version-specific adapters, and the legacy Squared linear format.
 *
 * Cycles, wait/resume, trigger registration, non-main AI connection types, and
 * n8n helper/context methods not implemented by the package adapter fail explicitly.
 */
export class GraphExecutionEngine {
	private readonly limits: Required<GraphEngineLimits>;
	private readonly registry: NodeAdapterRegistry;
	private readonly credentialProvider?: CredentialProvider;

	constructor(
		registry: NodeAdapterRegistry,
		credentialProvider?: CredentialProvider,
		limits: GraphEngineLimits = {},
	) {
		this.registry = registry;
		this.credentialProvider = credentialProvider;
		this.limits = {
			maxNodes: limits.maxNodes ?? 10_000,
			maxItems: limits.maxItems ?? 50_000,
			maxRetries: limits.maxRetries ?? 10,
			maxRetryDelayMs: limits.maxRetryDelayMs ?? 60_000,
		};
	}

	async execute(inputWorkflow: unknown, request: GraphExecutionRequest = {}): Promise<GraphExecutionResult> {
		const graph = buildWorkflowGraph(inputWorkflow);
		const executionId = request.executionId ?? globalThis.crypto.randomUUID();
		const mode = request.mode ?? 'manual';
		const nodeRuns: NodeRunRecord[] = [];
		const outputsByNode = new Map<string, Record<string, NodeExecutionData[][]>>();
		const contextData = new Map<string, Record<string, unknown>>();
		let workflowId = typeof graph.document.id === 'string' ? graph.document.id : undefined;

		try {
			if (graph.document.nodes.length > this.limits.maxNodes) {
				throw new Error(`Workflow node count exceeds the configured limit of ${this.limits.maxNodes}`);
			}
			const start = selectStartNode(graph, request.startNode);
			const reachable = reachableNodeNames(graph, start.name);
			const order = topologicalOrder(graph, reachable);
			for (const connection of graph.connections) {
				if (reachable.has(connection.source.name) && connection.sourceType !== 'main') {
					throw new Error(`Connection type ${connection.sourceType} is not supported by the graph engine`);
				}
				if (reachable.has(connection.target.name) && connection.targetType !== 'main') {
					throw new Error(`Connection type ${connection.targetType} is not supported by the graph engine`);
				}
			}

			const triggerItems = normalizeInput(request.input);
			assertItemLimit(triggerItems, this.limits.maxItems);
			outputsByNode.set(start.name, { main: [triggerItems] });
			nodeRuns.push({
				nodeId: start.id,
				nodeName: start.name,
				nodeType: start.type,
				...(typeof start.typeVersion === 'number' ? { typeVersion: start.typeVersion } : {}),
				status: 'succeeded',
				attempts: 0,
				inputItems: triggerItems.length,
				outputItems: triggerItems.length,
			});

			for (const node of order) {
				if (node.name === start.name) continue;
				const incoming = (graph.incoming.get(node.name) ?? []).filter((connection) => reachable.has(connection.source.name));
				if (incoming.length === 0) continue;
				const inputPorts = collectInputPorts(incoming, outputsByNode);
				const inputItems = inputPorts.flatMap((port) => port);
				if (inputItems.length === 0) {
					nodeRuns.push(makeRunRecord(node, 'skipped', 0, 0, 0));
					outputsByNode.set(node.name, { main: [] });
					continue;
				}
				assertItemLimit(inputItems, this.limits.maxItems);
				const portCount = getOutputPortCount(graph, node.name);
				if (node.disabled === true) {
					const bypass = inputPorts[0] ?? [];
					outputsByNode.set(node.name, { main: Array.from({ length: Math.max(portCount, 1) }, (_value, index) => index === 0 ? bypass : []) });
					nodeRuns.push(makeRunRecord(node, 'succeeded', 0, inputItems.length, bypass.length));
					continue;
				}

				const version = typeof node.typeVersion === 'number' ? node.typeVersion : 1;
				const adapter = await this.registry.resolve(node.type, version);
				if (!adapter) {
					const supported = this.registry.versions(node.type);
					const versionHint = supported.length ? `; supported versions: ${supported.join(', ')}` : '';
					throw new Error(`No executable adapter for ${node.type}@${version}${versionHint}`);
				}
				const context = createNodeContext({
					graph,
					node,
					inputPorts,
					outputsByNode,
					executionId,
					mode,
					contextData,
					credentialProvider: this.credentialProvider,
				});

				let attempts = 0;
				let output: NodeOutput;
				let nodeError: unknown;
				const retry = node.retryOnFail === true;
				const maxTries = retry ? Math.min(this.limits.maxRetries, positiveInteger(node.maxTries, 3)) : 1;
				const retryDelay = retry ? Math.min(this.limits.maxRetryDelayMs, nonNegativeInteger(node.waitBetweenTries, 1_000)) : 0;
				while (attempts < maxTries) {
					attempts += 1;
					try {
						output = await adapter.execute(context);
						nodeError = undefined;
						break;
					} catch (error) {
						nodeError = error;
						if (attempts < maxTries) await delay(retryDelay, context.signal);
					}
				}

				if (nodeError !== undefined) {
					const message = safeErrorMessage(nodeError);
					if (node.onError === 'continueErrorOutput') {
						const errorItems = inputPorts[0]?.map((item) => ({ ...item, error: { message } })) ?? [];
						const errorPorts = Array.from({ length: Math.max(portCount, 2) }, () => [] as NodeExecutionData[]);
						errorPorts[1] = errorItems;
						outputsByNode.set(node.name, { main: errorPorts });
						nodeRuns.push(makeRunRecord(node, 'continued', attempts, inputItems.length, errorItems.length, message));
						continue;
					}
					if (node.onError === 'continueRegularOutput' || node.continueOnFail === true) {
						const continued = inputPorts[0]?.map((item) => ({ ...item, error: { message } })) ?? [];
						outputsByNode.set(node.name, { main: [continued, ...Array.from({ length: Math.max(portCount - 1, 0) }, () => [])] });
						nodeRuns.push(makeRunRecord(node, 'continued', attempts, inputItems.length, continued.length, message));
						continue;
					}
					nodeRuns.push(makeRunRecord(node, 'failed', attempts, inputItems.length, 0, message));
					throw new Error(`Node ${node.name} failed: ${message}`);
				}

				const normalizedOutput = normalizeOutput(output, portCount);
				const outputItems = Object.values(normalizedOutput).flatMap((ports) => ports.flat()).length;
				assertItemLimit(Object.values(normalizedOutput).flatMap((ports) => ports.flat()), this.limits.maxItems);
				outputsByNode.set(node.name, normalizedOutput);
				nodeRuns.push(makeRunRecord(node, 'succeeded', attempts, inputItems.length, outputItems));
			}

			const terminalNodes = order.filter((node) =>
				node.name !== start.name && !(graph.outgoing.get(node.name) ?? []).some((connection) => reachable.has(connection.target.name)),
			);
			if (terminalNodes.length === 0 && !(graph.outgoing.get(start.name) ?? []).some((connection) => reachable.has(connection.target.name))) {
				terminalNodes.push(start);
			}
			const output = terminalNodes.flatMap((node) => {
				const nodeOutput = outputsByNode.get(node.name)?.main ?? [];
				return nodeOutput.flat();
			});
			const outputRecord = Object.fromEntries([...outputsByNode].map(([name, data]) => [name, data.main ?? []]));
			return {
				id: executionId,
				...(workflowId ? { workflowId } : {}),
				status: 'succeeded',
				output,
				outputsByNode: outputRecord,
				nodeRuns,
			};
		} catch (error) {
			return {
				id: executionId,
				...(workflowId ? { workflowId } : {}),
				status: 'failed',
				output: [],
				outputsByNode: Object.fromEntries([...outputsByNode].map(([name, data]) => [name, data.main ?? []])),
				nodeRuns,
				error: safeErrorMessage(error),
			};
		}
	}
}

function createNodeContext(args: {
	graph: WorkflowGraph;
	node: WorkflowNodeDocument;
	inputPorts: NodeExecutionData[][];
	outputsByNode: Map<string, Record<string, NodeExecutionData[][]>>;
	executionId: string;
	mode: GraphNodeContext['mode'];
	contextData: Map<string, Record<string, unknown>>;
	credentialProvider?: CredentialProvider;
}): GraphNodeContext {
	const { graph, node, inputPorts, outputsByNode, executionId, mode, contextData, credentialProvider } = args;
	const abortController = new AbortController();
	const flattenInputs = inputPorts.flat();
	const priorNodeItems = Object.fromEntries([...outputsByNode].map(([name, data]) => [name, (data.main ?? []).flat()]));
	const baseContext = (itemIndex: number): N8nExpressionContext => ({
		item: flattenInputs[itemIndex] ?? { json: {} },
		inputItems: flattenInputs,
		priorNodeItems,
		execution: { id: executionId, mode },
		workflow: { id: graph.document.id, name: graph.document.name },
	});
	const parameterAtPath = (path: string): unknown => {
		let value: unknown = node.parameters ?? {};
		const keys = path.match(/[^.[\]]+|\[(?:\d+|(['"])(.*?)\1)\]/g)?.map((part) => part.startsWith('[')
			? part.slice(1, -1).replace(/^(['"])(.*)\1$/, '$2')
			: part) ?? [];
		for (const key of keys) {
			if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Invalid node parameter path: ${path}`);
			if (typeof value !== 'object' || value === null) return undefined;
			value = (value as Record<string, unknown>)[key];
		}
		return value;
	};
	const loadCredentials = async (credentialType: string) => {
		const reference = node.credentials?.[credentialType];
		if (!reference) throw new Error(`Node ${node.name} has no ${credentialType} credential reference`);
		if (!credentialProvider) throw new Error('Credential provider is not configured');
		const credential = await credentialProvider(reference, credentialType, node);
		if (!credential) throw new Error(`Credential ${reference.name} was not found`);
		return credential;
	};
	return {
		executionId,
		mode,
		node,
		workflow: graph.document,
		signal: abortController.signal,
		getInputData(inputIndex = 0, connectionType = 'main') {
			if (connectionType !== 'main') throw new Error(`Input connection type ${connectionType} is not supported by the graph engine`);
			return inputPorts[inputIndex] ?? [];
		},
		getNodeParameter<T = unknown>(parameterName: string, itemIndex = 0, fallbackValue?: T, options: NodeParameterOptions = {}): T {
			const value = parameterAtPath(parameterName);
			if (value === undefined) {
				if (fallbackValue !== undefined) return fallbackValue;
				throw new Error(`Could not get parameter "${parameterName}"`);
			}
			if (options.rawExpressions) return value as T;
			return resolveParameterTree(value, baseContext(itemIndex)) as T;
		},
		evaluateExpression(expression: string, itemIndex = 0, fallbackValue?: unknown, throwOnMissing = true) {
			try {
				return evaluateN8nExpression(expression, baseContext(itemIndex));
			} catch (error) {
				if (throwOnMissing) throw error;
				return fallbackValue;
			}
		},
		getNode() { return node; },
		getWorkflow() { return graph.document; },
		getMode() { return mode; },
		getExecutionId() { return executionId; },
		getTimezone() { return typeof graph.document.settings?.timezone === 'string' ? graph.document.settings.timezone : 'UTC'; },
		getWorkflowSettings() { return graph.document.settings ?? {}; },
		getWorkflowStaticData(type: string) { return contextDataFor(type); },
		continueOnFail() { return node.continueOnFail === true || node.onError === 'continueErrorOutput' || node.onError === 'continueRegularOutput'; },
		getExecutionCancelSignal() { return abortController.signal; },
		getContext(type: 'flow' | 'node') {
			const key = type === 'flow' ? 'flow' : `node:${node.id}`;
			let value = contextData.get(key);
			if (!value) { value = {}; contextData.set(key, value); }
			return value;
		},
		sendMessageToUI() {},
		async prepareOutputData<T extends NodeExecutionData[]>(items: T) { return [items]; },
		helpers: createBasicHelpers(() => flattenInputs, loadCredentials),
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		async getCredentials(credentialType: string) { return loadCredentials(credentialType); },
	};

	function contextDataFor(type: string): Record<string, unknown> {
		const key = type === 'flow' || type === 'global' ? 'flow' : `node:${node.id}`;
		let value = contextData.get(key);
		if (!value) { value = {}; contextData.set(key, value); }
		return value;
	}
}

function createBasicHelpers(
	getInputs: () => NodeExecutionData[],
	getCredentials: (credentialType: string) => Promise<Record<string, unknown>>,
): GraphNodeContext['helpers'] {
	const getBinaryData = (itemIndex: number, propertyName: string) => {
		const binary = getInputs()[itemIndex]?.binary?.[propertyName];
		if (!binary) throw new Error(`Binary data property ${propertyName} was not found on item ${itemIndex}`);
		return binary;
	};
	return {
		returnJsonArray(items: unknown | unknown[]) {
			return (Array.isArray(items) ? items : [items]).map((item) => ({ json: isObject(item) ? item : { value: item } }));
		},
		copyInputItems(items: NodeExecutionData[], properties: string[]) {
			return items.map((item) => ({ json: Object.fromEntries(properties.filter((key) => Object.hasOwn(item.json, key)).map((key) => [key, item.json[key]])) }));
		},
		normalizeItems(items: unknown[]) {
			return items.map((item) => normalizeItem(item));
		},
		constructExecutionMetaData(items: NodeExecutionData[], { itemData }: { itemData?: Array<{ item: number; input?: number }> } = {}) {
			return items.map((item, index) => ({ ...item, pairedItem: itemData?.[index] ?? { item: index } }));
		},
		createDeferredPromise() {
			let resolve!: (value: unknown) => void;
			let reject!: (reason?: unknown) => void;
			const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
			return { promise, resolve, reject };
		},
		httpRequest(options: Record<string, unknown>) { return executeHttpRequest(options); },
		request(options: Record<string, unknown>) { return executeHttpRequest(options); },
		async httpRequestWithAuthentication(credentialType: string, options: Record<string, unknown>) {
			const credentials = await getCredentials(credentialType);
			return executeHttpRequest(applyGenericHttpAuthentication(options, credentials));
		},
		async requestWithAuthentication(credentialType: string, options: Record<string, unknown>) {
			const credentials = await getCredentials(credentialType);
			return executeHttpRequest(applyGenericHttpAuthentication(options, credentials));
		},
		async requestOAuth2(credentialType: string, options: Record<string, unknown>, oauthOptions: Record<string, unknown> = {}) {
			const credentials = await getCredentials(credentialType);
			const token = findOAuthAccessToken(credentials);
			if (!token) throw new Error(`Credential ${credentialType} has no OAuth2 access token`);
			const headers = { ...(isObject(options.headers) ? options.headers : {}) };
			headers.authorization = `${typeof oauthOptions.tokenType === 'string' ? oauthOptions.tokenType : 'Bearer'} ${token}`;
			return executeHttpRequest({ ...options, headers });
		},
		async requestOAuth1() { throw new Error('Squared does not implement OAuth 1 request signing yet'); },
		assertBinaryData(itemIndex: number, propertyName: string) {
			return getBinaryData(itemIndex, propertyName);
		},
		async getBinaryDataBuffer(itemIndex: number, propertyName: string) {
			const metadata = getBinaryData(itemIndex, propertyName) as { data?: string; dataId?: string; mimeType?: string };
			if (typeof metadata.data !== 'string') throw new Error('Squared does not have a binary-data store configured for this n8n item');
			return Buffer.from(metadata.data, 'base64');
		},
		async prepareBinaryData(value: Buffer | Uint8Array | ArrayBuffer | string, fileName?: string, mimeType?: string) {
			const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
			const resolvedMimeType = mimeType || 'application/octet-stream';
			const resolvedFileExtension = extname(fileName ?? '').replace(/^\./, '') || extensionForMimeType(resolvedMimeType);
			const resolvedFileName = fileName || (resolvedFileExtension ? `file.${resolvedFileExtension}` : 'file');
			return {
				data: buffer.toString('base64'),
				fileName: resolvedFileName,
				fileExtension: resolvedFileExtension,
				fileSize: `${buffer.byteLength} B`,
				mimeType: resolvedMimeType,
				fileType: resolvedMimeType.split('/')[0] || 'application',
			};
		},
		detectBinaryEncoding(buffer: Buffer) {
			return buffer.toString('utf8');
		},
	};
}

function extensionForMimeType(mimeType: string): string {
	const commonExtensions: Record<string, string> = {
		'application/json': 'json',
		'application/pdf': 'pdf',
		'application/zip': 'zip',
		'text/csv': 'csv',
		'text/html': 'html',
		'text/plain': 'txt',
		'text/xml': 'xml',
	};
	return commonExtensions[mimeType.toLowerCase()] ?? '';
}

async function executeHttpRequest(options: Record<string, unknown>): Promise<unknown> {
	const address = options.uri ?? options.url;
	if (typeof address !== 'string' || !address) throw new Error('HTTP helper needs a non-empty uri or url');
	const url = new URL(address);
	const query = (options.qs ?? options.query) as Record<string, unknown> | undefined;
	if (query && typeof query === 'object') {
		for (const [key, rawValue] of Object.entries(query)) {
			url.searchParams.delete(key);
			for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
				if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
			}
		}
	}
	const headers = new Headers();
	const inputHeaders = options.headers;
	if (inputHeaders && typeof inputHeaders === 'object') {
		for (const [key, value] of Object.entries(inputHeaders)) {
			if (value !== undefined && value !== null) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
		}
	}
	let body: BodyInit | undefined;
	const method = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET';
	if (options.form && typeof options.form === 'object') {
		body = new URLSearchParams(Object.entries(options.form as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
		if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
	} else if (options.formData && typeof options.formData === 'object') {
		const formData = new FormData();
		for (const [key, value] of Object.entries(options.formData as Record<string, unknown>)) {
			if (typeof value === 'string' || value instanceof Blob) formData.append(key, value);
			else if (value !== undefined && value !== null) formData.append(key, String(value));
		}
		body = formData;
	} else if (options.body !== undefined && options.body !== null && !['GET', 'HEAD'].includes(method)) {
		if (typeof options.body === 'string' || options.body instanceof Blob || options.body instanceof FormData) {
			body = options.body;
		} else if (options.body instanceof Uint8Array) {
			body = new Blob([Uint8Array.from(options.body)]);
		} else {
			body = JSON.stringify(options.body);
			if (!headers.has('content-type')) headers.set('content-type', options.json === false ? 'application/x-www-form-urlencoded' : 'application/json');
		}
	}
	const timeout = Number(options.timeout);
	const signal = Number.isFinite(timeout) && timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
	const response = await fetch(url, { method, headers, body, signal, redirect: options.followRedirect === false ? 'manual' : 'follow' });
	const bytes = Buffer.from(await response.arrayBuffer());
	const contentType = response.headers.get('content-type') ?? '';
	let responseBody: unknown = bytes.toString(typeof options.encoding === 'string' ? options.encoding as BufferEncoding : 'utf8');
	if (options.encoding === null) responseBody = bytes;
	else if (options.json === true || /(?:application|text)\/(?:[^;]+\+)?json\b/i.test(contentType)) {
		const text = bytes.toString('utf8');
		responseBody = text ? JSON.parse(text) : null;
	}
	if (!response.ok && options.simple !== false) {
		const error = new Error(`Request failed with status code ${response.status}`) as Error & { statusCode: number; response: unknown };
		error.statusCode = response.status;
		error.response = { statusCode: response.status, statusMessage: response.statusText, headers: responseHeaders(response.headers), body: responseBody };
		throw error;
	}
	if (options.resolveWithFullResponse === true || options.returnFullResponse === true) {
		return { statusCode: response.status, statusMessage: response.statusText, headers: responseHeaders(response.headers), body: responseBody };
	}
	return responseBody;
}

function responseHeaders(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => { result[key] = value; });
	return result;
}

function applyGenericHttpAuthentication(options: Record<string, unknown>, credentials: Record<string, unknown>): Record<string, unknown> {
	const authenticated: Record<string, unknown> = { ...options, headers: { ...(isObject(options.headers) ? options.headers : {}) } };
	const headers = authenticated.headers as Record<string, unknown>;
	if (typeof credentials.header === 'string' && typeof credentials.value === 'string') {
		headers[credentials.header] = credentials.value;
	} else if (typeof credentials.name === 'string' && typeof credentials.value === 'string') {
		if (credentials.in === 'query') {
			const qs: Record<string, unknown> = isObject(options.qs) ? { ...options.qs } : {};
			qs[credentials.name] = credentials.value;
			authenticated.qs = qs;
		} else headers[credentials.name] = credentials.value;
	} else if (typeof credentials.user === 'string' && typeof credentials.password === 'string') {
		headers.authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`;
	} else if (findOAuthAccessToken(credentials)) {
		headers.authorization = `Bearer ${findOAuthAccessToken(credentials)}`;
	} else if (isObject(credentials.headers)) {
		Object.assign(headers, credentials.headers);
	} else {
		throw new Error('Squared cannot adapt this n8n credential schema for an HTTP request yet');
	}
	return authenticated;
}

function findOAuthAccessToken(credentials: Record<string, unknown>): string | undefined {
	const tokenData = isObject(credentials.oauthTokenData) ? credentials.oauthTokenData : {};
	const token = credentials.accessToken ?? credentials.token ?? tokenData.access_token;
	return typeof token === 'string' && token ? token : undefined;
}

function selectStartNode(graph: WorkflowGraph, requested?: string): WorkflowNodeDocument {
	if (requested) {
		const byName = graph.nodesByName.get(requested);
		const byId = graph.document.nodes.find((node) => node.id === requested);
		const node = byName ?? byId;
		if (!node) throw new Error(`Start node not found: ${requested}`);
		return node;
	}
	const rootNodes = graph.document.nodes.filter((node) => (graph.incoming.get(node.name) ?? []).length === 0);
	const triggerNodes = rootNodes.filter((node) => node.type.toLowerCase().includes('trigger') || node.type.startsWith('trigger.'));
	const candidates = triggerNodes.length === 1 ? triggerNodes : rootNodes;
	if (candidates.length !== 1) throw new Error('Specify startNode when the workflow has multiple start nodes');
	const start = candidates[0];
	if (!start) throw new Error('Workflow has no start node');
	return start;
}

function reachableNodeNames(graph: WorkflowGraph, startName: string): Set<string> {
	const reachable = new Set<string>();
	const stack = [startName];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || reachable.has(current)) continue;
		reachable.add(current);
		for (const connection of graph.outgoing.get(current) ?? []) stack.push(connection.target.name);
	}
	return reachable;
}

function topologicalOrder(graph: WorkflowGraph, reachable: Set<string>): WorkflowNodeDocument[] {
	const inDegree = new Map<string, number>();
	for (const name of reachable) inDegree.set(name, 0);
	for (const connection of graph.connections) {
		if (reachable.has(connection.source.name) && reachable.has(connection.target.name)) {
			inDegree.set(connection.target.name, (inDegree.get(connection.target.name) ?? 0) + 1);
		}
	}
	const ready = [...reachable].filter((name) => inDegree.get(name) === 0);
	const result: WorkflowNodeDocument[] = [];
	while (ready.length > 0) {
		const name = ready.shift();
		if (!name) continue;
		const node = graph.nodesByName.get(name);
		if (!node) continue;
		result.push(node);
		for (const connection of graph.outgoing.get(name) ?? []) {
			if (!reachable.has(connection.target.name)) continue;
			const remaining = (inDegree.get(connection.target.name) ?? 1) - 1;
			inDegree.set(connection.target.name, remaining);
			if (remaining === 0) ready.push(connection.target.name);
		}
	}
	if (result.length !== reachable.size) throw new Error('Workflow contains a cycle; loop execution is not supported yet');
	return result;
}

function collectInputPorts(
	connections: WorkflowConnection[],
	outputsByNode: Map<string, Record<string, NodeExecutionData[][]>>,
): NodeExecutionData[][] {
	const maximumInput = Math.max(0, ...connections.map((connection) => connection.targetInput));
	const ports = Array.from({ length: maximumInput + 1 }, () => [] as NodeExecutionData[]);
	for (const connection of connections) {
		const sourceOutputs = outputsByNode.get(connection.source.name)?.[connection.sourceType] ?? [];
		const data = sourceOutputs[connection.sourceOutput] ?? [];
		ports[connection.targetInput]?.push(...data);
	}
	return ports;
}

function getOutputPortCount(graph: WorkflowGraph, nodeName: string): number {
	const outputs = (graph.outgoing.get(nodeName) ?? []).map((connection) => connection.sourceOutput);
	return outputs.length ? Math.max(...outputs) + 1 : 1;
}

function normalizeOutput(output: NodeOutput, minimumPorts: number): Record<string, NodeExecutionData[][]> {
	if (output === null || output === undefined) return { main: Array.from({ length: minimumPorts }, () => []) };
	const channels = Array.isArray(output) ? { main: output } : output;
	const normalized: Record<string, NodeExecutionData[][]> = Object.create(null);
	for (const [type, ports] of Object.entries(channels)) {
		if (!Array.isArray(ports)) throw new Error(`Node output ${type} must be an array of output ports`);
		normalized[type] = ports.map((port) => {
			if (!Array.isArray(port)) throw new Error(`Node output ${type} contains an invalid port`);
			return port.map(normalizeItem);
		});
	}
	const main = normalized.main ?? [];
	while (main.length < minimumPorts) main.push([]);
	normalized.main = main;
	return normalized;
}

function normalizeInput(input: unknown): NodeExecutionData[] {
	const values = Array.isArray(input) ? input : [input ?? {}];
	return values.map(normalizeItem);
}

function normalizeItem(item: unknown): NodeExecutionData {
	if (isObject(item) && isObject(item.json)) {
		return structuredClone(item) as NodeExecutionData;
	}
	if (isObject(item)) return { json: structuredClone(item) };
	return { json: { value: item } };
}

function assertItemLimit(items: NodeExecutionData[], limit: number): void {
	if (items.length > limit) throw new Error(`Execution item count exceeds the configured limit of ${limit}`);
}

function makeRunRecord(
	node: WorkflowNodeDocument,
	status: NodeRunRecord['status'],
	attempts: number,
	inputItems: number,
	outputItems: number,
	error?: string,
): NodeRunRecord {
	return {
		nodeId: node.id,
		nodeName: node.name,
		nodeType: node.type,
		...(typeof node.typeVersion === 'number' ? { typeVersion: node.typeVersion } : {}),
		status,
		attempts,
		inputItems,
		outputItems,
		...(error ? { error } : {}),
	};
}

function positiveInteger(value: unknown, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
	return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function safeErrorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (milliseconds === 0) return Promise.resolve();
	if (signal.aborted) return Promise.reject(new Error('Execution cancelled'));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('Execution cancelled'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
