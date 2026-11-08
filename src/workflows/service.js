import { randomUUID } from 'node:crypto';
import { normalizeWorkflow } from './definition.js';
import { RequestError } from '../errors.js';

export class WorkflowService {
	constructor(store, executionEngine) {
		this.store = store;
		this.executionEngine = executionEngine;
	}

	list() {
		return this.store.listWorkflows();
	}

	async get(id) {
		const workflow = await this.store.getWorkflow(id);
		if (!workflow) throw new RequestError(404, 'Workflow not found');
		return workflow;
	}

	async save(input, id) {
		try {
			return await this.store.saveWorkflow(normalizeWorkflow(input, id || input.id || randomUUID()));
		} catch (error) {
			if (!error.statusCode) error.statusCode = 400;
			throw error;
		}
	}

	async remove(id) {
		const deleted = await this.store.deleteWorkflow(id);
		if (!deleted) throw new RequestError(404, 'Workflow not found');
	}

	async execute(id, triggerType, input = {}) {
		const workflow = await this.get(id);
		if (triggerType !== 'manual' && !workflow.active) throw new RequestError(409, 'Workflow is inactive');
		const trigger = workflow.nodes[0].type;
		const expectedType = `trigger.${triggerType}`;
		if (trigger !== expectedType) throw new RequestError(409, `Workflow does not use ${triggerType} trigger`);
		return this.executionEngine.submit(workflow, triggerType, input);
	}
}
