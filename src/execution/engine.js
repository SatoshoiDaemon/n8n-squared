import { randomUUID } from 'node:crypto';
import { ExecutionQueue } from './queue.js';
import { RequestError } from '../errors.js';

export class ExecutionEngine {
	constructor({ store, registry, graphEngine, concurrency, maxQueued, requestTimeoutMs, maxResponseBytes }) {
		this.store = store;
		this.registry = registry;
		this.graphEngine = graphEngine;
		this.queue = new ExecutionQueue({ concurrency, maxQueued });
		this.requestTimeoutMs = requestTimeoutMs;
		this.maxResponseBytes = maxResponseBytes;
		this.activeTriggers = new Map();
	}

	async submit(workflow, triggerType, input = {}, executionOptions = {}) {
		if (this.queue.size >= this.queue.maxQueued) throw new RequestError(429, 'Execution queue is full');
		if (!['manual', 'webhook', 'schedule', 'trigger', 'poll'].includes(triggerType)) throw new RequestError(400, 'Invalid trigger type');
		const id = randomUUID();
		await this.store.createExecution({ id, workflowId: workflow.id, triggerType, input });
		try {
			this.queue.enqueue(() => this.#run(id, workflow, input, triggerType, executionOptions));
		} catch (error) {
			await this.store.failExecution(id, error.message);
			throw error;
		}
		return { id, status: 'queued' };
	}

	async resumeWaitingExecution(id, input) {
		const waiting = await this.store.getWaitingExecution?.(id);
		if (!waiting) throw new RequestError(404, 'Waiting execution not found');
		if (!waiting.waitState.acceptsResumeRequest) throw new RequestError(409, 'This execution can resume only when its wait deadline is reached');
		return this.#enqueueResume(waiting, input ?? waiting.waitState.input);
	}

	async resumeDueWaits(now = Date.now()) {
		const due = await this.store.listDueWaitingExecutions?.(now) ?? [];
		let resumed = 0;
		for (const waiting of due) {
			if (this.queue.size >= this.queue.maxQueued) break;
			try {
				await this.#enqueueResume(waiting, waiting.waitState.input);
				resumed += 1;
			} catch (error) {
				if (error.statusCode === 429) break;
				await this.store.failExecution(waiting.id, error?.message ?? error);
			}
		}
		return resumed;
	}

	async reconcileTriggers(entries) {
		const wanted = new Map(entries.map((entry) => [
			`${entry.workflow.id}:${entry.node.name}`,
			{ ...entry, signature: JSON.stringify(entry.workflow) },
		]));
		for (const [key, active] of this.activeTriggers) {
			const next = wanted.get(key);
			if (next?.signature === active.signature) {
				wanted.delete(key);
				continue;
			}
			await active.close?.();
			this.activeTriggers.delete(key);
		}
		for (const [key, entry] of wanted) {
			const staticData = await this.store.getWorkflowRuntimeState?.(entry.workflow.id) ?? {};
			const close = await this.graphEngine?.activateTrigger(entry.workflow, entry.node.name, async (data, nextStaticData) => {
				await this.store.saveWorkflowRuntimeState?.(entry.workflow.id, nextStaticData);
				await this.submit(entry.workflow, 'trigger', {}, { startNode: entry.node.name, initialOutput: data });
			}, staticData);
			this.activeTriggers.set(key, { signature: entry.signature, close });
		}
		return this.activeTriggers.size;
	}

	async deactivateAllTriggers() {
		const active = [...this.activeTriggers.values()];
		this.activeTriggers.clear();
		for (const trigger of active) await trigger.close?.();
	}

	async executeWebhook(workflow, nodeName, input, webhookRequest) {
		if (!this.graphEngine?.prepareWebhook) throw new RequestError(501, 'n8n webhook execution is unavailable');
		const staticData = await this.store.getWorkflowRuntimeState?.(workflow.id) ?? {};
		const prepared = await this.graphEngine.prepareWebhook(workflow, nodeName, webhookRequest, staticData);
		await this.store.saveWorkflowRuntimeState?.(workflow.id, prepared.staticData);
		const webhookResult = prepared.result && typeof prepared.result === 'object' ? prepared.result : {};
		if (webhookResult.noWebhookResponse === true) {
			return { status: 'webhook-response', noExecution: true, webhookResponse: webhookResult, capturedResponse: prepared.response };
		}
		const workflowData = webhookResult.workflowData ?? [];
		const queued = await this.submit(workflow, 'webhook', input, { startNode: nodeName, initialOutput: workflowData });
		return { ...queued, webhookResponse: webhookResult.webhookResponse, capturedResponse: prepared.response };
	}

	drain() {
		return this.queue.waitForIdle();
	}

	async #run(id, workflow, input, triggerType, executionOptions) {
		try {
			await this.store.startExecution(id);
			if (this.graphEngine && isGraphWorkflow(workflow)) {
				const staticData = await this.store.getWorkflowRuntimeState?.(workflow.id) ?? {};
				const result = await this.graphEngine.execute(workflow, {
					input,
					executionId: id,
					mode: triggerType,
					staticData,
					executionMetadata: executionOptions.metadata,
					resolveWorkflow: async (workflowInfo) => {
						if (workflowInfo.code && typeof workflowInfo.code === 'object') return workflowInfo.code;
						return workflowInfo.id ? await this.store.getWorkflow(workflowInfo.id) : undefined;
					},
					getWorkflowStaticData: async (workflowId) => await this.store.getWorkflowRuntimeState?.(workflowId) ?? {},
					saveWorkflowStaticData: async (workflowId, state) => await this.store.saveWorkflowRuntimeState?.(workflowId, state),
					...(executionOptions.initialOutput ? { initialOutput: executionOptions.initialOutput } : {}),
					...(executionOptions.startNode ? { startNode: executionOptions.startNode } : {}),
					...(executionOptions.webhookRequest ? { webhookRequest: executionOptions.webhookRequest } : {}),
				});
				await this.store.saveWorkflowRuntimeState?.(workflow.id, result.staticData);
				if (result.status === 'waiting') {
					await this.store.suspendExecution(id, result.waitState);
					return;
				}
				if (result.status === 'failed') throw new Error(result.error || 'Graph workflow execution failed');
				await this.store.finishExecution(id, {
					id: result.id,
					workflowId: result.workflowId,
					output: result.output,
					outputsByNode: result.outputsByNode,
					nodeRuns: result.nodeRuns,
					metadata: result.metadata,
				});
				return;
			}
			let current = input && typeof input === 'object' && !Array.isArray(input) ? input : { value: input };
			for (const node of workflow.nodes.slice(1)) {
				const run = this.registry.get(node.type);
				if (!run) throw new Error(`No runtime registered for ${node.type}`);
				const context = { json: current, executionId: id };
				const output = await run(current, node.parameters, context);
				if (node.type === 'logic.if') {
					if (!output) {
						current = null;
						break;
					}
					continue;
				}
				current = output;
			}
			await this.store.finishExecution(id, current);
		} catch (error) {
			await this.store.failExecution(id, error?.message ?? error);
		}
	}

	async #enqueueResume(waiting, input) {
		if (this.queue.size >= this.queue.maxQueued) throw new RequestError(429, 'Execution queue is full');
		const workflow = await this.store.getWorkflow(waiting.workflowId);
		if (!workflow) throw new RequestError(404, 'Workflow for waiting execution was not found');
		this.queue.enqueue(() => this.#run(waiting.id, workflow, input, waiting.triggerType, {
			startNode: waiting.waitState.nodeName,
			metadata: waiting.waitState.metadata,
			initialOutput: [Array.isArray(input) ? input : [input]],
		}));
		return { id: waiting.id, status: 'queued' };
	}
}

function isGraphWorkflow(workflow) {
	return Boolean(workflow && typeof workflow === 'object' && (
		(workflow.connections && typeof workflow.connections === 'object') ||
		workflow.nodes?.some((node) => typeof node.type === 'string' && node.type.startsWith('n8n-nodes-'))
	));
}
