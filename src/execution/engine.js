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
	}

	async submit(workflow, triggerType, input = {}, executionOptions = {}) {
		if (this.queue.size >= this.queue.maxQueued) throw new RequestError(429, 'Execution queue is full');
		if (!['manual', 'webhook', 'schedule'].includes(triggerType)) throw new RequestError(400, 'Invalid trigger type');
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

	drain() {
		return this.queue.waitForIdle();
	}

	async #run(id, workflow, input, triggerType, executionOptions) {
		try {
			await this.store.startExecution(id);
			if (this.graphEngine && isGraphWorkflow(workflow)) {
				const result = await this.graphEngine.execute(workflow, {
					input,
					executionId: id,
					mode: triggerType,
					...(executionOptions.startNode ? { startNode: executionOptions.startNode } : {}),
				});
				if (result.status === 'failed') throw new Error(result.error || 'Graph workflow execution failed');
				await this.store.finishExecution(id, {
					id: result.id,
					workflowId: result.workflowId,
					output: result.output,
					outputsByNode: result.outputsByNode,
					nodeRuns: result.nodeRuns,
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
}

function isGraphWorkflow(workflow) {
	return Boolean(workflow && typeof workflow === 'object' && (
		(workflow.connections && typeof workflow.connections === 'object') ||
		workflow.nodes?.some((node) => typeof node.type === 'string' && node.type.startsWith('n8n-nodes-'))
	));
}
