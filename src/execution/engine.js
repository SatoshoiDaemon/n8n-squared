import { randomUUID } from 'node:crypto';
import { ExecutionQueue } from './queue.js';
import { RequestError } from '../errors.js';

export class ExecutionEngine {
	constructor({ store, registry, concurrency, maxQueued, requestTimeoutMs, maxResponseBytes }) {
		this.store = store;
		this.registry = registry;
		this.queue = new ExecutionQueue({ concurrency, maxQueued });
		this.requestTimeoutMs = requestTimeoutMs;
		this.maxResponseBytes = maxResponseBytes;
	}

	async submit(workflow, triggerType, input = {}) {
		if (this.queue.size >= this.queue.maxQueued) throw new RequestError(429, 'Execution queue is full');
		if (!['manual', 'webhook', 'schedule'].includes(triggerType)) throw new RequestError(400, 'Invalid trigger type');
		const id = randomUUID();
		await this.store.createExecution({ id, workflowId: workflow.id, triggerType, input });
		try {
			this.queue.enqueue(() => this.#run(id, workflow, input));
		} catch (error) {
			await this.store.failExecution(id, error.message);
			throw error;
		}
		return { id, status: 'queued' };
	}

	drain() {
		return this.queue.waitForIdle();
	}

	async #run(id, workflow, input) {
		try {
			await this.store.startExecution(id);
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
