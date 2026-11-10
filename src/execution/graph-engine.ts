import { evaluateN8nExpression, resolveParameterTree, type ExpressionItem, type N8nExpressionContext } from '../expressions/n8n-expression.ts';
import { buildWorkflowGraph, type WorkflowConnection, type WorkflowDocument, type WorkflowGraph, type WorkflowNodeDocument } from '../workflows/n8n-format.ts';
import { createHmac, randomBytes } from 'node:crypto';
import { extname } from 'node:path';

export interface NodeExecutionData extends ExpressionItem {
	json: Record<string, unknown>;
	binary?: Record<string, unknown>;
	pairedItem?: number | { item: number; input?: number } | Array<number | { item: number; input?: number }>;
	error?: { message: string; description?: string; [key: string]: unknown };
}

export type NodeOutput = NodeExecutionData[][] | Record<string, unknown[][]> | null | undefined;

export interface SuppliedNodeData {
	response: unknown;
	closeFunction?: () => void | Promise<void>;
}

export interface GraphNodeContext {
	readonly executionId: string;
	readonly mode: 'manual' | 'webhook' | 'schedule' | 'trigger' | 'poll';
	readonly node: WorkflowNodeDocument;
	readonly workflow: WorkflowDocument;
	readonly signal: AbortSignal;
	getInputData(inputIndex?: number, connectionType?: string): NodeExecutionData[];
	getInputConnectionData(connectionType: string, inputIndex?: number, itemIndex?: number): Promise<unknown>;
	getNodeParameter<T = unknown>(parameterName: string, itemIndex?: number, fallbackValue?: T, options?: NodeParameterOptions): T;
	evaluateExpression(expression: string, itemIndex?: number, fallbackValue?: unknown, throwOnMissing?: boolean, additional?: Record<string, unknown>): unknown;
	getNode(): WorkflowNodeDocument;
	getWorkflow(): WorkflowDocument;
	getMode(): GraphNodeContext['mode'];
	getExecutionId(): string;
	getTimezone(): string;
	getWorkflowSettings(): Record<string, unknown>;
	getWorkflowStaticData(type: string): Record<string, unknown>;
	continueOnFail(): boolean;
	getExecutionCancelSignal(): AbortSignal;
	getNodeWebhookUrl(name: string): string | undefined;
	getParentNodes(nodeName: string): WorkflowNodeDocument[];
	setMetadata(metadata: Record<string, unknown>): void;
	getMetadata(): Record<string, unknown>;
	getRequestObject(): GraphWebhookRequest;
	getResponseObject(): Record<string, unknown>;
	getWebhookName(): string;
	getBodyData(): unknown;
	getQueryData(): Record<string, unknown>;
	getHeaderData(): Record<string, string | string[] | undefined>;
	getParamsData(): Record<string, unknown>;
	getContext(type: 'flow' | 'node'): Record<string, unknown>;
	sendMessageToUI(...args: unknown[]): void;
	addInputData(connectionType: string, data: unknown[][], runIndex?: number): { index: number };
	addOutputData(connectionType: string, runIndex: number, data: unknown[][] | Error, metadata?: Record<string, unknown>, sourceNodeRunIndex?: number): void;
	logAiEvent(eventName: string, payload?: string): void;
	prepareOutputData<T extends NodeExecutionData[]>(items: T, inputIndex?: number): Promise<[T]>;
	putExecutionToWait(waitTill: Date, options?: { acceptsResumeRequest?: boolean }): Promise<void>;
	getPendingWait(): GraphWaitState | undefined;
	readonly helpers: Record<string, (...args: any[]) => any>;
	readonly logger: Record<string, (...args: unknown[]) => void>;
	getCredentials(credentialType: string): Promise<Record<string, unknown>>;
	updateCredentials(credentialType: string, credentials: Record<string, unknown>): Promise<void>;
	emit(data: NodeExecutionData[][]): Promise<void>;
}

export interface GraphWaitState {
	nodeName: string;
	resumeAt: string | null;
	acceptsResumeRequest: boolean;
	input: NodeExecutionData[];
	metadata?: Record<string, unknown>;
}

export interface GraphWebhookRequest {
	method: string;
	url: string;
	path: string;
	headers: Record<string, string | string[] | undefined>;
	query: Record<string, unknown>;
	body: unknown;
	params: Record<string, unknown>;
	rawBody?: Uint8Array;
	webhookName?: string;
	contentType?: string;
	ip?: string;
	ips?: string[];
	readRawBody?: () => Promise<Uint8Array>;
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
	execute?(context: GraphNodeContext): Promise<NodeOutput>;
	trigger?(context: GraphNodeContext): Promise<unknown>;
	poll?(context: GraphNodeContext): Promise<NodeOutput>;
	webhook?(context: GraphNodeContext): Promise<unknown>;
	supplyData?(context: GraphNodeContext): Promise<Record<string, SuppliedNodeData>>;
}

export type CredentialProvider = ((
	reference: { id?: string; name: string },
	credentialType: string,
	node: WorkflowNodeDocument,
) => Promise<Record<string, unknown> | null>) & {
	update?: (
		reference: { id?: string; name: string },
		credentialType: string,
		node: WorkflowNodeDocument,
		credentials: Record<string, unknown>,
	) => Promise<void>;
};

export interface GraphEngineLimits {
	maxNodes?: number;
	maxItems?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	binaryStore?: { store(buffer: Buffer): Promise<string>; retrieve(id: string): Promise<Buffer> };
}

export interface GraphExecutionRequest {
	input?: unknown;
	startNode?: string;
	executionId?: string;
	mode?: GraphNodeContext['mode'];
	staticData?: Record<string, Record<string, unknown>>;
	executionMetadata?: Record<string, unknown>;
	initialOutput?: NodeExecutionData[][];
	webhookRequest?: GraphWebhookRequest;
}

export interface NodeRunRecord {
	nodeId: string;
	nodeName: string;
	nodeType: string;
	typeVersion?: number;
	status: 'succeeded' | 'skipped' | 'failed' | 'continued' | 'waiting';
	attempts: number;
	inputItems: number;
	outputItems: number;
	error?: string;
}

export interface GraphExecutionResult {
	id: string;
	workflowId?: string;
	status: 'succeeded' | 'failed' | 'waiting';
	output: NodeExecutionData[];
	outputsByNode: Record<string, NodeExecutionData[][]>;
	nodeRuns: NodeRunRecord[];
	staticData: Record<string, Record<string, unknown>>;
	metadata: Record<string, unknown>;
	waitState?: GraphWaitState;
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
	 * Cycles and non-main AI connection types fail explicitly. Published node
	 * adapters supply execution, poll, and trigger lifecycle hooks on demand.
 */
export class GraphExecutionEngine {
	private readonly limits: Required<Omit<GraphEngineLimits, 'binaryStore'>>;
	private readonly registry: NodeAdapterRegistry;
	private readonly credentialProvider?: CredentialProvider;
	private readonly binaryStore?: GraphEngineLimits['binaryStore'];

	constructor(
		registry: NodeAdapterRegistry,
		credentialProvider?: CredentialProvider,
		limits: GraphEngineLimits = {},
	) {
		this.registry = registry;
		this.credentialProvider = credentialProvider;
		this.binaryStore = limits.binaryStore;
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
		const outputsByNode = new Map<string, Record<string, unknown[][]>>();
		const contextData = new Map<string, Record<string, unknown>>(
			Object.entries(request.staticData ?? {}).map(([key, value]) => [key, { ...value }]),
		);
		const executionMetadata = new Map<string, unknown>(Object.entries(request.executionMetadata ?? {}));
		const closeFunctions: Array<() => void | Promise<void>> = [];
		const closeSuppliedResources = async () => {
			const callbacks = closeFunctions.splice(0).reverse();
			let firstError: unknown;
			for (const closeFunction of callbacks) {
				try { await closeFunction(); } catch (error) { firstError ??= error; }
			}
			if (firstError !== undefined) throw firstError;
		};
		let workflowId = typeof graph.document.id === 'string' ? graph.document.id : undefined;

		try {
			if (graph.document.nodes.length > this.limits.maxNodes) {
				throw new Error(`Workflow node count exceeds the configured limit of ${this.limits.maxNodes}`);
			}
			const start = selectStartNode(graph, request.startNode);
			const reachable = reachableNodeNames(graph, start.name);
			const order = topologicalOrder(graph, reachable);
			const triggerItems = normalizeInput(request.input);
			assertItemLimit(triggerItems, this.limits.maxItems);
			let initialOutput = request.initialOutput?.map((port) => port.map(normalizeItem)) ?? [triggerItems];
			let initialOutputRecord: Record<string, unknown[][]> = { main: initialOutput };
			if (mode === 'poll') {
				const version = typeof start.typeVersion === 'number' ? start.typeVersion : 1;
				const adapter = await this.registry.resolve(start.type, version);
				if (!adapter?.poll) throw new Error(`Node ${start.type}@${version} does not implement poll()`);
				const context = createNodeContext({ graph, node: start, inputPorts: [], outputsByNode, executionId, mode, contextData, executionMetadata, credentialProvider: this.credentialProvider, binaryStore: this.binaryStore });
				initialOutputRecord = normalizeOutput(await adapter.poll(context), getOutputPortCount(graph, start.name), []);
				initialOutput = nodeExecutionPorts(initialOutputRecord.main ?? []);
			}
			if (mode === 'webhook' && request.webhookRequest) {
				const version = typeof start.typeVersion === 'number' ? start.typeVersion : 1;
				const adapter = await this.registry.resolve(start.type, version);
				if (!adapter?.webhook) throw new Error(`Node ${start.type}@${version} does not implement webhook()`);
				const context = createNodeContext({ graph, node: start, inputPorts: [], outputsByNode, executionId, mode, contextData, executionMetadata, credentialProvider: this.credentialProvider, binaryStore: this.binaryStore, webhookRequest: request.webhookRequest });
				const result = await adapter.webhook(context);
				const workflowData = isObject(result) && 'workflowData' in result ? result.workflowData : result;
				initialOutputRecord = normalizeOutput(workflowData as NodeOutput, getOutputPortCount(graph, start.name), []);
				initialOutput = nodeExecutionPorts(initialOutputRecord.main ?? []);
			}
			assertItemLimit(Object.values(initialOutputRecord).flatMap((ports) => ports.flat()), this.limits.maxItems);
			outputsByNode.set(start.name, initialOutputRecord);
			nodeRuns.push({
				nodeId: start.id,
				nodeName: start.name,
				nodeType: start.type,
				...(typeof start.typeVersion === 'number' ? { typeVersion: start.typeVersion } : {}),
				status: 'succeeded',
				attempts: 0,
				inputItems: triggerItems.length,
				outputItems: Object.values(initialOutputRecord).flatMap((ports) => ports.flat()).length,
			});

			for (const node of order) {
				if (node.name === start.name) continue;
				const incoming = (graph.incoming.get(node.name) ?? []).filter((connection) => reachable.has(connection.source.name));
				const version = typeof node.typeVersion === 'number' ? node.typeVersion : 1;
				const adapter = await this.registry.resolve(node.type, version);
				if (incoming.length === 0 && !adapter?.supplyData) continue;
				let inputPorts = collectInputPorts(incoming, outputsByNode);
				if (adapter?.supplyData && !inputPorts.some((port) => port.length > 0)) {
					inputPorts = inheritAiSubNodeInputPorts(node, graph, outputsByNode) ?? inputPorts;
				}
				const inputItems = inputPorts.flatMap((port) => port);
				if (inputItems.length === 0 && !incoming.some((connection) => connection.targetType !== 'main') && !adapter?.supplyData) {
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

				if (!adapter?.execute && !adapter?.supplyData) {
					const supported = this.registry.versions(node.type);
					const versionHint = supported.length ? `; supported versions: ${supported.join(', ')}` : '';
					throw new Error(`No execute() adapter for ${node.type}@${version}${versionHint}`);
				}
				const context = createNodeContext({
					graph,
					node,
					inputPorts,
					outputsByNode,
					executionId,
					mode,
					contextData,
					executionMetadata,
					credentialProvider: this.credentialProvider,
					binaryStore: this.binaryStore,
				});
				const hasMainInputConnection = (graph.incoming.get(node.name) ?? []).some((connection) => connection.targetType === 'main');

				let attempts = 0;
				let output: NodeOutput;
				let nodeError: unknown;
				const retry = node.retryOnFail === true;
				const maxTries = retry ? Math.min(this.limits.maxRetries, positiveInteger(node.maxTries, 3)) : 1;
				const retryDelay = retry ? Math.min(this.limits.maxRetryDelayMs, nonNegativeInteger(node.waitBetweenTries, 1_000)) : 0;
				while (attempts < maxTries) {
					attempts += 1;
					try {
						if (adapter.execute && ((hasMainInputConnection && inputItems.length > 0) || !adapter.supplyData)) output = await adapter.execute(context);
						else {
							const supplied = await adapter.supplyData!(context);
							for (const value of Object.values(supplied ?? {})) {
								if (typeof value.closeFunction === 'function') closeFunctions.push(value.closeFunction);
							}
							output = Object.fromEntries(Object.entries(supplied ?? {}).map(([type, value]) => [type, [[value.response]]]));
						}
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

				const normalizedOutput = normalizeOutput(output, portCount, inputPorts);
				const outputItems = Object.values(normalizedOutput).flatMap((ports) => ports.flat()).length;
				assertItemLimit(Object.values(normalizedOutput).flatMap((ports) => ports.flat()), this.limits.maxItems);
				outputsByNode.set(node.name, normalizedOutput);
				const waitState = context.getPendingWait();
				if (waitState) {
					await closeSuppliedResources();
					nodeRuns.push(makeRunRecord(node, 'waiting', attempts, inputItems.length, outputItems));
					return {
						id: executionId,
						...(workflowId ? { workflowId } : {}),
						status: 'waiting',
						output: [],
					outputsByNode: Object.fromEntries([...outputsByNode].map(([name, data]) => [name, nodeExecutionPorts(data.main ?? [])])),
						nodeRuns,
						staticData: snapshotContextData(contextData),
						waitState: { ...waitState, nodeName: node.name, input: (normalizedOutput.main?.[0] ?? []).filter(isNodeExecutionData) },
						metadata: snapshotExecutionMetadata(executionMetadata),
					};
				}
				nodeRuns.push(makeRunRecord(node, 'succeeded', attempts, inputItems.length, outputItems));
			}
			await closeSuppliedResources();

			const terminalNodes = order.filter((node) =>
				node.name !== start.name && !(graph.outgoing.get(node.name) ?? []).some((connection) => reachable.has(connection.target.name)),
			);
			if (terminalNodes.length === 0 && !(graph.outgoing.get(start.name) ?? []).some((connection) => reachable.has(connection.target.name))) {
				terminalNodes.push(start);
			}
			const output = terminalNodes.flatMap((node) => {
				const nodeOutput = outputsByNode.get(node.name)?.main ?? [];
				return nodeExecutionPorts(nodeOutput).flat();
			});
			const outputRecord = Object.fromEntries([...outputsByNode].map(([name, data]) => [name, nodeExecutionPorts(data.main ?? [])]));
			return {
				id: executionId,
				...(workflowId ? { workflowId } : {}),
				status: 'succeeded',
				output,
				outputsByNode: outputRecord,
				nodeRuns,
				staticData: snapshotContextData(contextData),
				metadata: snapshotExecutionMetadata(executionMetadata),
			};
		} catch (error) {
			try { await closeSuppliedResources(); } catch { /* keep the original execution failure */ }
			return {
				id: executionId,
				...(workflowId ? { workflowId } : {}),
				status: 'failed',
				output: [],
				outputsByNode: Object.fromEntries([...outputsByNode].map(([name, data]) => [name, nodeExecutionPorts(data.main ?? [])])),
				nodeRuns,
				staticData: snapshotContextData(contextData),
				metadata: snapshotExecutionMetadata(executionMetadata),
				error: safeErrorMessage(error),
			};
		}
	}

	async activateTrigger(
		inputWorkflow: unknown,
		startNode: string,
		emit: (data: NodeExecutionData[][], staticData: Record<string, Record<string, unknown>>) => Promise<void>,
		staticData: Record<string, Record<string, unknown>> = {},
	): Promise<(() => void | Promise<void>) | undefined> {
		const graph = buildWorkflowGraph(inputWorkflow);
		const node = graph.nodesByName.get(startNode);
		if (!node) throw new Error(`Trigger node ${startNode} was not found in the workflow`);
		const version = typeof node.typeVersion === 'number' ? node.typeVersion : 1;
		const adapter = await this.registry.resolve(node.type, version);
		if (!adapter?.trigger) return undefined;
		const contextData = new Map<string, Record<string, unknown>>(
			Object.entries(staticData).map(([key, value]) => [key, { ...value }]),
		);
		const executionMetadata = new Map<string, unknown>();
		const context = createNodeContext({
			graph,
			node,
			inputPorts: [],
			outputsByNode: new Map(),
			executionId: globalThis.crypto.randomUUID(),
			mode: 'trigger',
			contextData,
			executionMetadata,
			credentialProvider: this.credentialProvider,
			binaryStore: this.binaryStore,
			emit: async (data) => emit(data.map((port) => port.map(normalizeItem)), snapshotContextData(contextData)),
		});
		const result = await adapter.trigger(context);
		if (typeof result === 'function') return result as () => void | Promise<void>;
		if (result && typeof result === 'object' && typeof (result as { closeFunction?: unknown }).closeFunction === 'function') {
			return (result as { closeFunction: () => void | Promise<void> }).closeFunction;
		}
		return undefined;
	}

	async prepareWebhook(inputWorkflow: unknown, nodeName: string, webhookRequest: GraphWebhookRequest, staticData: Record<string, Record<string, unknown>> = {}) {
		const graph = buildWorkflowGraph(inputWorkflow);
		const node = graph.nodesByName.get(nodeName);
		if (!node) throw new Error(`Webhook node ${nodeName} was not found in the workflow`);
		const version = typeof node.typeVersion === 'number' ? node.typeVersion : 1;
		const adapter = await this.registry.resolve(node.type, version);
		if (!adapter?.webhook) throw new Error(`Node ${node.type}@${version} does not implement webhook()`);
		const contextData = new Map<string, Record<string, unknown>>(
			Object.entries(staticData).map(([key, value]) => [key, { ...value }]),
		);
		const executionMetadata = new Map<string, unknown>();
		const response = createCapturedWebhookResponse();
		const context = createNodeContext({
			graph,
			node,
			inputPorts: [],
			outputsByNode: new Map(),
			executionId: globalThis.crypto.randomUUID(),
			mode: 'webhook',
			contextData,
			executionMetadata,
			credentialProvider: this.credentialProvider,
			binaryStore: this.binaryStore,
			webhookRequest,
			webhookResponse: response,
		});
		const result = await adapter.webhook(context);
		return { result, response, staticData: snapshotContextData(contextData) };
	}
}

function createNodeContext(args: {
	graph: WorkflowGraph;
	node: WorkflowNodeDocument;
	inputPorts: NodeExecutionData[][];
	outputsByNode: Map<string, Record<string, unknown[][]>>;
	executionId: string;
	mode: GraphNodeContext['mode'];
	contextData: Map<string, Record<string, unknown>>;
	executionMetadata: Map<string, unknown>;
	credentialProvider?: CredentialProvider;
	binaryStore?: GraphEngineLimits['binaryStore'];
	emit?: (data: NodeExecutionData[][]) => Promise<void>;
	webhookRequest?: GraphWebhookRequest;
	webhookResponse?: Record<string, unknown>;
}): GraphNodeContext {
const { graph, node, inputPorts, outputsByNode, executionId, mode, contextData, executionMetadata, credentialProvider, binaryStore } = args;
	const abortController = new AbortController();
	let pendingWait: Omit<GraphWaitState, 'nodeName' | 'input'> | undefined;
	const flattenInputs = inputPorts.flat();
	const priorNodeItems = Object.fromEntries([...outputsByNode].map(([name, data]) => [name, nodeExecutionPorts(data.main ?? []).flat()]));
	const baseContext = (itemIndex: number, additional: Record<string, unknown> = {}): N8nExpressionContext => ({
		item: flattenInputs[itemIndex] ?? { json: {} },
		inputItems: flattenInputs,
		priorNodeItems,
		execution: { id: executionId, mode, ...Object.fromEntries(executionMetadata) },
		workflow: { id: graph.document.id, name: graph.document.name },
		additional: { $parameter: node.parameters ?? {}, $vars: {}, ...additional },
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
		async getInputConnectionData(connectionType: string, inputIndex = 0, itemIndex = 0) {
			const connection = (graph.incoming.get(node.name) ?? []).find((item) => item.targetType === connectionType && item.targetInput === inputIndex);
			if (!connection) throw new Error(`Node ${node.name} has no ${connectionType} input at index ${inputIndex}`);
			const sourcePorts = outputsByNode.get(connection.source.name)?.[connection.sourceType] ?? [];
			return sourcePorts[connection.sourceOutput]?.[itemIndex];
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
		evaluateExpression(expression: string, itemIndex = 0, fallbackValue?: unknown, throwOnMissing = true, additional: Record<string, unknown> = {}) {
			try {
				return evaluateN8nExpression(expression, baseContext(itemIndex, additional));
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
		getNodeWebhookUrl(_name: string) { return args.webhookRequest?.url; },
		getParentNodes(nodeName: string) {
			const parents = new Set<string>();
			const pending = (graph.incoming.get(nodeName) ?? []).map((connection) => connection.source.name);
			while (pending.length) {
				const parent = pending.pop()!;
				if (parents.has(parent)) continue;
				parents.add(parent);
				pending.push(...(graph.incoming.get(parent) ?? []).map((connection) => connection.source.name));
			}
			return [...parents].map((name) => graph.nodesByName.get(name)).filter((parent): parent is WorkflowNodeDocument => Boolean(parent));
		},
		setMetadata(values: Record<string, unknown>) {
			for (const [key, value] of Object.entries(values)) executionMetadata.set(key, structuredClone(value));
		},
		getMetadata() { return snapshotExecutionMetadata(executionMetadata); },
		getRequestObject() {
			if (!args.webhookRequest) throw new Error('This node context is not attached to an HTTP webhook request');
			return args.webhookRequest;
		},
		getResponseObject() {
			if (!args.webhookRequest) throw new Error('This node context is not attached to an HTTP webhook request');
			return args.webhookResponse ?? {};
		},
		getWebhookName() { return args.webhookRequest?.webhookName ?? 'default'; },
		getBodyData() { return args.webhookRequest?.body; },
		getQueryData() { return args.webhookRequest?.query ?? {}; },
		getHeaderData() { return args.webhookRequest?.headers ?? {}; },
		getParamsData() { return args.webhookRequest?.params ?? {}; },
		getContext(type: 'flow' | 'node') {
			const key = type === 'flow' ? 'flow' : `node:${node.id}`;
			let value = contextData.get(key);
			if (!value) { value = {}; contextData.set(key, value); }
			return value;
		},
		sendMessageToUI() {},
		addInputData(connectionType: string, data: unknown[][], runIndex?: number) {
			const runs = getLoggedSubNodeRuns();
			const nodeRuns = runs[node.name] ?? (runs[node.name] = []);
			const index = nodeRuns.length;
			nodeRuns.push({ connectionType, status: 'running', input: cloneForExecutionMetadata(data), ...(runIndex !== undefined ? { sourceRunIndex: runIndex } : {}) });
			return { index };
		},
		addOutputData(connectionType: string, runIndex: number, data: unknown[][] | Error, metadata?: Record<string, unknown>, sourceNodeRunIndex?: number) {
			const runs = getLoggedSubNodeRuns();
			const nodeRuns = runs[node.name] ?? (runs[node.name] = []);
			const loggedRun = nodeRuns[runIndex] ?? (nodeRuns[runIndex] = { connectionType, status: 'running' });
			loggedRun.connectionType = connectionType;
			loggedRun.status = data instanceof Error ? 'failed' : 'succeeded';
			loggedRun.output = cloneForExecutionMetadata(data);
			if (metadata !== undefined) loggedRun.metadata = cloneForExecutionMetadata(metadata);
			if (sourceNodeRunIndex !== undefined) loggedRun.sourceRunIndex = sourceNodeRunIndex;
		},
		logAiEvent(eventName: string, payload?: string) {
			const events = (executionMetadata.get('n8nAiEvents') as Array<Record<string, unknown>> | undefined) ?? [];
			events.push({ event: eventName, ...(payload !== undefined ? { payload } : {}), nodeName: node.name });
			executionMetadata.set('n8nAiEvents', events);
		},
		async prepareOutputData<T extends NodeExecutionData[]>(items: T) { return [items]; },
		async putExecutionToWait(waitTill: Date, options: { acceptsResumeRequest?: boolean } = {}) {
			const timestamp = waitTill instanceof Date ? waitTill.getTime() : Number.NaN;
			if (!Number.isFinite(timestamp)) throw new Error('putExecutionToWait requires a valid deadline');
			pendingWait = {
				resumeAt: timestamp >= Date.parse('2999-01-01T00:00:00.000Z') ? null : new Date(timestamp).toISOString(),
				acceptsResumeRequest: options.acceptsResumeRequest !== false,
				metadata: snapshotExecutionMetadata(executionMetadata),
			};
		},
		getPendingWait() {
			return pendingWait ? { ...pendingWait, nodeName: node.name, input: [] } : undefined;
		},
		helpers: createBasicHelpers(() => flattenInputs, loadCredentials, binaryStore, async (credentialType, credentials) => {
			const reference = node.credentials?.[credentialType];
			if (!reference) throw new Error(`Node ${node.name} has no ${credentialType} credential reference`);
			if (!credentialProvider?.update) throw new Error('Credential provider does not support encrypted credential updates');
			await credentialProvider.update(reference, credentialType, node, credentials);
		}),
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		async getCredentials(credentialType: string) { return loadCredentials(credentialType); },
		async updateCredentials(credentialType: string, credentials: Record<string, unknown>) {
			const reference = node.credentials?.[credentialType];
			if (!reference) throw new Error(`Node ${node.name} has no ${credentialType} credential reference`);
			if (!credentialProvider?.update) throw new Error('Credential provider does not support encrypted credential updates');
			await credentialProvider.update(reference, credentialType, node, credentials);
		},
		async emit(data: NodeExecutionData[][]) {
			if (!args.emit) throw new Error('This node context is not attached to an active trigger');
			await args.emit(data);
		},
	};

	function contextDataFor(type: string): Record<string, unknown> {
		const key = type === 'flow' || type === 'global' ? 'flow' : `node:${node.id}`;
		let value = contextData.get(key);
		if (!value) { value = {}; contextData.set(key, value); }
		return value;
	}

	function getLoggedSubNodeRuns(): Record<string, Array<Record<string, unknown>>> {
		const runs = (executionMetadata.get('n8nSubNodeRuns') as Record<string, Array<Record<string, unknown>>> | undefined) ?? {};
		executionMetadata.set('n8nSubNodeRuns', runs);
		return runs;
	}
}

function cloneForExecutionMetadata(value: unknown): unknown {
	try { return structuredClone(value); } catch { return String(value); }
}

function createBasicHelpers(
	getInputs: () => NodeExecutionData[],
	getCredentials: (credentialType: string) => Promise<Record<string, unknown>>,
	binaryStore?: GraphEngineLimits['binaryStore'],
	updateCredentials: (credentialType: string, credentials: Record<string, unknown>) => Promise<void> = async () => {
		throw new Error('Credential provider does not support encrypted credential updates');
	},
): GraphNodeContext['helpers'] {
	const getBinaryData = (itemIndex: number, propertyName: string) => {
		const binary = getInputs()[itemIndex]?.binary?.[propertyName];
		if (!binary) throw new Error(`Binary data property ${propertyName} was not found on item ${itemIndex}`);
		return binary;
	};
	const getBinaryBuffer = async (itemIndex: number, propertyName: string) => {
		const metadata = getBinaryData(itemIndex, propertyName) as { data?: string; dataId?: string; mimeType?: string };
		if (typeof metadata.data === 'string') return Buffer.from(metadata.data, 'base64');
		if (typeof metadata.dataId === 'string' && binaryStore) return binaryStore.retrieve(metadata.dataId);
		throw new Error('Binary data is stored by reference, but no persistent binary-data store is configured');
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
			const accessToken = await getFreshOAuth2AccessToken(credentialType, credentials, oauthOptions, updateCredentials);
			const headers = { ...(isObject(options.headers) ? options.headers : {}) };
			const tokenData = isObject(credentials.oauthTokenData) ? credentials.oauthTokenData : {};
			headers.authorization = `${String(tokenData.token_type ?? oauthOptions.tokenType ?? 'Bearer')} ${accessToken}`;
			return executeHttpRequest({ ...options, headers });
		},
		async requestOAuth1(credentialType: string, options: Record<string, unknown>) {
			const credentials = await getCredentials(credentialType);
			return executeHttpRequest(signOAuth1Request(options, credentials));
		},
		async refreshOAuth2Token(credentialType: string, oauthOptions: Record<string, unknown> = {}) {
			const credentials = await getCredentials(credentialType);
			await getFreshOAuth2AccessToken(credentialType, credentials, { ...oauthOptions, forceRefresh: true }, updateCredentials);
			return isObject(credentials.oauthTokenData) ? credentials.oauthTokenData : {};
		},
		async requestWithAuthenticationPaginated(
			requestOptions: Record<string, unknown>,
			itemIndex: number,
			paginationOptions: Record<string, unknown>,
			credentialType?: string,
		) {
			return requestPages(requestOptions, itemIndex, paginationOptions, credentialType, getInputs, getCredentials);
		},
		assertBinaryData(itemIndex: number, propertyName: string) {
			return getBinaryData(itemIndex, propertyName);
		},
		async getBinaryDataBuffer(itemIndex: number, propertyName: string) {
			return getBinaryBuffer(itemIndex, propertyName);
		},
		async getBinaryDataStream(itemIndex: number, propertyName: string) {
			const { Readable } = await import('node:stream');
			return Readable.from(await getBinaryBuffer(itemIndex, propertyName));
		},
		async prepareBinaryData(value: Buffer | Uint8Array | ArrayBuffer | string, fileName?: string, mimeType?: string, properties: Record<string, unknown> = {}) {
			const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
			const resolvedMimeType = mimeType || 'application/octet-stream';
			const resolvedFileExtension = extname(fileName ?? '').replace(/^\./, '') || extensionForMimeType(resolvedMimeType);
			const resolvedFileName = fileName || (resolvedFileExtension ? `file.${resolvedFileExtension}` : 'file');
			const dataReference = buffer.byteLength > 1_048_576 && binaryStore ? { dataId: await binaryStore.store(buffer) } : { data: buffer.toString('base64') };
			return {
				...properties,
				...dataReference,
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
	let url: URL;
	try {
		url = new URL(address);
	} catch (error) {
		if (typeof options.baseURL !== 'string' || !options.baseURL) throw error;
		const base = new URL(options.baseURL);
		const basePath = base.pathname.replace(/\/+$/, '');
		const requestPath = address.replace(/^\/+/, '');
		url = new URL(`${base.origin}${basePath}/${requestPath}`);
	}
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
		body = options.form instanceof URLSearchParams
			? options.form
			: new URLSearchParams(Object.entries(options.form as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
		if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
	} else if (options.formData && typeof options.formData === 'object') {
		const formData = new FormData();
		for (const [key, value] of Object.entries(options.formData as Record<string, unknown>)) {
			if (typeof value === 'string' || value instanceof Blob) formData.append(key, value);
			else if (value !== undefined && value !== null) formData.append(key, String(value));
		}
		body = formData;
	} else if (options.body !== undefined && options.body !== null && !['GET', 'HEAD'].includes(method)) {
		if (typeof options.body === 'string' || options.body instanceof Blob || options.body instanceof FormData || options.body instanceof URLSearchParams) {
			body = options.body;
		} else if (options.body instanceof Uint8Array) {
			body = new Blob([Uint8Array.from(options.body)]);
		} else if (options.json === false && typeof options.body === 'object') {
			body = new URLSearchParams(Object.entries(options.body as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
			if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
		} else {
			body = JSON.stringify(options.body);
			if (!headers.has('content-type')) headers.set('content-type', 'application/json');
		}
	}
	const timeoutOption = isObject(options.timeout) ? options.timeout.request : options.timeout;
	const timeout = Number(timeoutOption);
	const signal = Number.isFinite(timeout) && timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
	const response = await fetch(url, { method, headers, body, signal, redirect: options.followRedirect === false ? 'manual' : 'follow' });
	const bytes = Buffer.from(await response.arrayBuffer());
	const contentType = response.headers.get('content-type') ?? '';
	const textEncoding = typeof options.encoding === 'string' && options.encoding !== 'text' ? options.encoding as BufferEncoding : 'utf8';
	let responseBody: unknown = bytes.toString(textEncoding);
	if (options.encoding === null || options.responseType === 'arraybuffer' || options.responseType === 'buffer') responseBody = bytes;
	else if (options.json === true || /(?:application|text)\/(?:[^;]+\+)?json\b/i.test(contentType)) {
		const text = bytes.toString('utf8');
		responseBody = text ? JSON.parse(text) : null;
	}
	if (!response.ok && options.simple !== false && options.ignoreHttpStatusErrors !== true) {
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

async function getFreshOAuth2AccessToken(
	credentialType: string,
	credentials: Record<string, unknown>,
	oauthOptions: Record<string, unknown>,
	updateCredentials: (credentialType: string, credentials: Record<string, unknown>) => Promise<void>,
): Promise<string> {
	const existing = isObject(credentials.oauthTokenData) ? credentials.oauthTokenData : {};
	const expiryText = existing.n8n_expires_at ?? credentials.expiresAt;
	const expiry = typeof expiryText === 'string' ? Date.parse(expiryText) : Number(expiryText);
	const hasKnownExpiry = Number.isFinite(expiry) && expiry > 0;
	const needsRefresh = oauthOptions.forceRefresh === true || (hasKnownExpiry && expiry <= Date.now() + 30_000);
	if (needsRefresh) {
		const refreshToken = typeof existing.refresh_token === 'string' ? existing.refresh_token : undefined;
		if (!refreshToken) throw new Error(`OAuth2 credential ${credentialType} expired without a refresh token`);
		const tokenUrl = credentials.accessTokenUrl ?? credentials.accessTokenUri ?? credentials.tokenUrl;
		if (typeof tokenUrl !== 'string' || !tokenUrl) throw new Error(`OAuth2 credential ${credentialType} has no access token URL for refresh`);
		const clientId = credentials.clientId ?? credentials.client_id;
		const clientSecret = credentials.clientSecret ?? credentials.client_secret;
		const authentication = oauthOptions.authentication ?? credentials.authentication ?? 'header';
		const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
		if (typeof existing.resource === 'string' && existing.resource) body.set('resource', existing.resource);
		const headers: Record<string, string> = { accept: 'application/json' };
		if (authentication === 'body') {
			if (typeof clientId === 'string') body.set('client_id', clientId);
			if (typeof clientSecret === 'string') body.set('client_secret', clientSecret);
		} else if (typeof clientId === 'string' && typeof clientSecret === 'string') {
			headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
		} else if (typeof clientId === 'string') {
			body.set('client_id', clientId);
		}
		const refreshed = await executeHttpRequest({ method: 'POST', url: tokenUrl, headers, body, json: true, timeout: 300_000 }) as Record<string, unknown>;
		if (!isObject(refreshed) || typeof refreshed.access_token !== 'string' || !refreshed.access_token) {
			throw new Error(`OAuth2 credential ${credentialType} refresh response did not include an access token`);
		}
		const nextTokenData: Record<string, unknown> = {
			...existing,
			...refreshed,
			refresh_token: typeof refreshed.refresh_token === 'string' && refreshed.refresh_token ? refreshed.refresh_token : refreshToken,
		};
		if (Number.isFinite(Number(refreshed.expires_in))) {
			nextTokenData.n8n_expires_at = new Date(Date.now() + Number(refreshed.expires_in) * 1_000).toISOString();
		}
		credentials.oauthTokenData = nextTokenData;
		await updateCredentials(credentialType, credentials);
	}
	const token = findOAuthAccessToken(credentials);
	if (!token) throw new Error(`Credential ${credentialType} has no OAuth2 access token`);
	return token;
}

function signOAuth1Request(options: Record<string, unknown>, credentials: Record<string, unknown>): Record<string, unknown> {
	const address = options.uri ?? options.url;
	if (typeof address !== 'string' || !address) throw new Error('OAuth1 request needs a non-empty uri or url');
	const url = new URL(address);
	const tokenData = isObject(credentials.oauthTokenData) ? credentials.oauthTokenData : {};
	const consumerKey = credentials.consumerKey ?? credentials.consumer_key ?? credentials.clientId;
	const consumerSecret = credentials.consumerSecret ?? credentials.consumer_secret ?? credentials.clientSecret;
	const token = tokenData.oauth_token ?? credentials.accessToken ?? credentials.token;
	const tokenSecret = tokenData.oauth_token_secret ?? credentials.tokenSecret ?? credentials.oauthTokenSecret;
	if (![consumerKey, consumerSecret, token, tokenSecret].every((value) => typeof value === 'string' && value.length > 0)) {
		throw new Error('OAuth1 credential requires consumer key/secret and access token/secret');
	}
	const method = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET';
	const oauth: Record<string, string> = {
		oauth_consumer_key: String(consumerKey),
		oauth_nonce: randomBytes(16).toString('hex'),
		oauth_signature_method: 'HMAC-SHA1',
		oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
		oauth_token: String(token),
		oauth_version: '1.0',
	};
	const parameters: Array<[string, string]> = [];
	url.searchParams.forEach((value, key) => parameters.push([key, value]));
	for (const [key, value] of Object.entries((options.qs ?? options.query) as Record<string, unknown> ?? {})) {
		for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined && entry !== null) parameters.push([key, String(entry)]);
	}
	if (options.form && typeof options.form === 'object') {
		for (const [key, value] of Object.entries(options.form as Record<string, unknown>)) parameters.push([key, String(value)]);
	} else if (typeof options.body === 'object' && options.body !== null && options.json === false) {
		for (const [key, value] of Object.entries(options.body as Record<string, unknown>)) parameters.push([key, String(value)]);
	}
	parameters.push(...Object.entries(oauth));
	const normalized = parameters.map(([key, value]) => [oauthEncode(key), oauthEncode(value)] as const)
		.sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
		.map(([key, value]) => `${key}=${value}`).join('&');
	const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
	const baseString = [method, oauthEncode(baseUrl), oauthEncode(normalized)].join('&');
	oauth.oauth_signature = createHmac('sha1', `${oauthEncode(String(consumerSecret))}&${oauthEncode(String(tokenSecret))}`).update(baseString).digest('base64');
	const header = Object.entries(oauth).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`).join(', ');
	return { ...options, headers: { ...(isObject(options.headers) ? options.headers : {}), authorization: `OAuth ${header}` } };
}

function oauthEncode(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function requestPages(
	requestOptions: Record<string, unknown>,
	itemIndex: number,
	paginationOptions: Record<string, unknown>,
	credentialType: string | undefined,
	getInputs: () => NodeExecutionData[],
	getCredentials: (credentialType: string) => Promise<Record<string, unknown>>,
): Promise<unknown[]> {
	const pages: unknown[] = [];
	const inputs = getInputs();
	const item = inputs[itemIndex] ?? { json: {} };
	const additional: Record<string, unknown> = { $request: requestOptions, $response: {}, $pageCount: 0 };
	const maxRequestsValue = paginationOptions.maxRequests === undefined ? 100 : Number(paginationOptions.maxRequests);
	const maxRequests = Number.isFinite(maxRequestsValue) && maxRequestsValue > 0 ? Math.min(Math.floor(maxRequestsValue), 10_000) : 100;
	let priorBodyHash = '';
	let repeatedBodyCount = 0;
	for (let page = 0; page < maxRequests; page++) {
		const resolvedPage = resolveParameterTree(paginationOptions.request ?? {}, { item, inputItems: inputs, additional }) as Record<string, unknown>;
		const pageOptions = mergePaginationOptions(requestOptions, resolvedPage);
		const address = pageOptions.uri ?? pageOptions.url;
		if (typeof address !== 'string' || !address) throw new Error('Pagination request has no valid URL');
		const prepared = { ...pageOptions, resolveWithFullResponse: true, simple: false };
			let authenticated: Record<string, unknown> = prepared;
		if (credentialType) authenticated = applyGenericHttpAuthentication(prepared, await getCredentials(credentialType));
		const response = await executeHttpRequest(authenticated) as { statusCode: number; statusMessage?: string; headers: Record<string, string>; body: unknown };
		pages.push(response);
		additional.$response = response;
		additional.$pageCount = page + 1;
		const bodyHash = JSON.stringify(response.body ?? null);
		if (bodyHash === priorBodyHash) repeatedBodyCount += 1;
		else repeatedBodyCount = 0;
		priorBodyHash = bodyHash;
		if (repeatedBodyCount >= 4) throw new Error('Pagination returned the same response repeatedly; check the pagination completion rule');
		const shouldContinue = resolveParameterTree(paginationOptions.continue ?? false, { item, inputItems: inputs, additional });
		if (shouldContinue !== true) return pages;
		if (response.statusCode < 200 || response.statusCode >= 300) {
			const error = new Error(`Request failed with status code ${response.statusCode}`) as Error & { statusCode: number; response: unknown };
			error.statusCode = response.statusCode;
			error.response = response;
			throw error;
		}
		const interval = Number(resolveParameterTree(paginationOptions.requestInterval ?? 0, { item, inputItems: inputs, additional }));
		if (Number.isFinite(interval) && interval > 0) await delay(Math.min(interval, 120_000), new AbortController().signal);
	}
	return pages;
}

function mergePaginationOptions(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base, ...next };
	if (isObject(base.headers) || isObject(next.headers)) result.headers = { ...(isObject(base.headers) ? base.headers : {}), ...(isObject(next.headers) ? next.headers : {}) };
	if (isObject(base.qs) || isObject(next.qs)) result.qs = { ...(isObject(base.qs) ? base.qs : {}), ...(isObject(next.qs) ? next.qs : {}) };
	if (isObject(base.query) || isObject(next.query)) result.query = { ...(isObject(base.query) ? base.query : {}), ...(isObject(next.query) ? next.query : {}) };
	if ('formData' in base && next.body !== undefined) { result.formData = next.body; delete result.body; }
	else if ('form' in base && next.body !== undefined) { result.form = next.body; delete result.body; }
	if (typeof next.url === 'string' && isObject(result.qs)) {
		const nextUrl = new URL(next.url);
		for (const key of nextUrl.searchParams.keys()) delete result.qs[key];
	}
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
		for (const connection of graph.incoming.get(current) ?? []) {
			if (connection.targetType !== 'main' || connection.sourceType !== 'main') stack.push(connection.source.name);
		}
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
	outputsByNode: Map<string, Record<string, unknown[][]>>,
): NodeExecutionData[][] {
	const mainConnections = connections.filter((connection) => connection.targetType === 'main' && connection.sourceType === 'main');
	const maximumInput = Math.max(0, ...mainConnections.map((connection) => connection.targetInput));
	const ports = Array.from({ length: maximumInput + 1 }, () => [] as NodeExecutionData[]);
	for (const connection of mainConnections) {
		const sourceOutputs = outputsByNode.get(connection.source.name)?.[connection.sourceType] ?? [];
		const data = sourceOutputs[connection.sourceOutput] ?? [];
		ports[connection.targetInput]?.push(...data.filter(isNodeExecutionData));
	}
	return ports;
}

function inheritAiSubNodeInputPorts(
	node: WorkflowNodeDocument,
	graph: WorkflowGraph,
	outputsByNode: Map<string, Record<string, unknown[][]>>,
	visited = new Set<string>(),
): NodeExecutionData[][] | undefined {
	if (visited.has(node.name)) return undefined;
	visited.add(node.name);
	for (const connection of graph.outgoing.get(node.name) ?? []) {
		if (connection.sourceType === 'main' && connection.targetType === 'main') continue;
		const parent = connection.target;
		const parentInputs = collectInputPorts(graph.incoming.get(parent.name) ?? [], outputsByNode);
		if (parentInputs.some((port) => port.length > 0)) return parentInputs;
		const inherited = inheritAiSubNodeInputPorts(parent, graph, outputsByNode, visited);
		if (inherited?.some((port) => port.length > 0)) return inherited;
	}
	return undefined;
}

function getOutputPortCount(graph: WorkflowGraph, nodeName: string): number {
	const outputs = (graph.outgoing.get(nodeName) ?? []).filter((connection) => connection.sourceType === 'main').map((connection) => connection.sourceOutput);
	return outputs.length ? Math.max(...outputs) + 1 : 1;
}

function normalizeOutput(output: NodeOutput, minimumPorts: number, inputPorts: NodeExecutionData[][] = []): Record<string, unknown[][]> {
	if (output === null || output === undefined) return { main: Array.from({ length: minimumPorts }, () => []) };
	const channels = Array.isArray(output) ? { main: output } : output;
	const normalized: Record<string, unknown[][]> = Object.create(null);
	for (const [type, ports] of Object.entries(channels)) {
		if (!Array.isArray(ports)) throw new Error(`Node output ${type} must be an array of output ports`);
		if (type !== 'main') {
			normalized[type] = ports.map((port) => {
				if (!Array.isArray(port)) throw new Error(`Node output ${type} contains an invalid port`);
				return [...port];
			});
			continue;
		}
			normalized[type] = ports.map((port) => {
			if (!Array.isArray(port)) throw new Error(`Node output ${type} contains an invalid port`);
			return port.map((item, outputIndex) => normalizePairedItem(normalizeItem(item), outputIndex, inputPorts));
		});
	}
	const main = normalized.main ?? [];
	while (main.length < minimumPorts) main.push([]);
	normalized.main = main;
	return normalized;
}

function normalizePairedItem(
	item: NodeExecutionData,
	outputIndex: number,
	inputPorts: NodeExecutionData[][],
): NodeExecutionData {
	if (item.pairedItem !== undefined) return item;
	for (let inputIndex = 0; inputIndex < inputPorts.length; inputIndex++) {
		const linkedItem = inputPorts[inputIndex]?.findIndex((candidate) => candidate === item) ?? -1;
		if (linkedItem >= 0) return { ...item, pairedItem: { item: linkedItem, input: inputIndex } };
	}
	if (inputPorts.length === 1 && outputIndex < (inputPorts[0]?.length ?? 0)) {
		return { ...item, pairedItem: { item: outputIndex, input: 0 } };
	}
	return item;
}

function snapshotContextData(contextData: Map<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
	return Object.fromEntries([...contextData].map(([key, value]) => [key, structuredClone(value)]));
}

function snapshotExecutionMetadata(metadata: Map<string, unknown>): Record<string, unknown> {
	return Object.fromEntries([...metadata].map(([key, value]) => [key, structuredClone(value)]));
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

function assertItemLimit(items: readonly unknown[], limit: number): void {
	if (items.length > limit) throw new Error(`Execution item count exceeds the configured limit of ${limit}`);
}

function nodeExecutionPorts(ports: unknown[][]): NodeExecutionData[][] {
	return ports.map((port) => port.filter(isNodeExecutionData));
}

function isNodeExecutionData(value: unknown): value is NodeExecutionData {
	return isObject(value) && isObject(value.json);
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

function createCapturedWebhookResponse(): Record<string, unknown> {
	const response: Record<string, unknown> = {
		statusCode: 200,
		headers: {} as Record<string, string>,
		body: undefined,
		ended: false,
		writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, string>, headers?: Record<string, string>) {
			response.statusCode = statusCode;
			const selectedHeaders = typeof statusMessageOrHeaders === 'object' ? statusMessageOrHeaders : headers;
			if (selectedHeaders) Object.assign(response.headers as Record<string, string>, selectedHeaders);
			return response;
		},
		setHeader(name: string, value: string) { (response.headers as Record<string, string>)[name.toLowerCase()] = value; return response; },
		getHeader(name: string) { return (response.headers as Record<string, string>)[name.toLowerCase()]; },
		removeHeader(name: string) { delete (response.headers as Record<string, string>)[name.toLowerCase()]; },
		write(chunk: unknown) { response.body = `${String(response.body ?? '')}${String(chunk ?? '')}`; return true; },
		end(body?: unknown) { if (body !== undefined) response.body = body; response.ended = true; return response; },
		flushHeaders() { response.headersSent = true; },
	};
	return response;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
