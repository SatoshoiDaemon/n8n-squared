import { randomUUID } from 'node:crypto';

export const TRIGGERS = new Set(['trigger.manual', 'trigger.webhook', 'trigger.schedule']);
export const NODE_TYPES = new Set([...TRIGGERS, 'data.set', 'http.request', 'logic.if']);

export function normalizeWorkflow(input, id = randomUUID()) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow must be an object');
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (!name || name.length > 120) throw new Error('Workflow name must contain 1 to 120 characters');
	if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 100) {
		throw new Error('Workflow must contain between 1 and 100 nodes');
	}
	const nodes = input.nodes.map((node, index) => {
		if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`Node ${index + 1} must be an object`);
		if (!NODE_TYPES.has(node.type)) throw new Error(`Unsupported node type: ${String(node.type)}`);
		const nodeId = typeof node.id === 'string' && node.id ? node.id : randomUUID();
		const nodeName = typeof node.name === 'string' ? node.name.trim() : '';
		if (!nodeName || nodeName.length > 120) throw new Error(`Node ${index + 1} needs a name`);
		const parameters = structuredClone(node.parameters ?? {});
		if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
			throw new Error(`Node ${nodeName} parameters must be an object`);
		}
		return { id: nodeId, type: node.type, name: nodeName, parameters };
	});
	if (new Set(nodes.map(({ id: nodeId }) => nodeId)).size !== nodes.length) throw new Error('Node IDs must be unique');
	if (!TRIGGERS.has(nodes[0].type)) throw new Error('The first node must be a trigger');
	if (nodes.slice(1).some(({ type }) => TRIGGERS.has(type))) throw new Error('Only the first node can be a trigger');
	if (nodes[0].type === 'trigger.schedule') {
		const interval = Number(nodes[0].parameters.intervalSeconds ?? 60);
		if (!Number.isInteger(interval) || interval < 5 || interval > 86_400) {
			throw new Error('Schedule intervalSeconds must be between 5 and 86400');
		}
		nodes[0].parameters.intervalSeconds = interval;
	}
	return { id, name, active: Boolean(input.active), nodes };
}
