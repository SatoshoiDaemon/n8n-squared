/**
 * Lossless workflow document types for the n8n export format and Squared's
 * original linear format. Unknown JSON fields deliberately remain part of the
 * document so an import/export round trip does not erase future metadata.
 */

export type JsonObject = Record<string, unknown>;

export interface WorkflowNodeDocument extends JsonObject {
	id: string;
	name: string;
	type: string;
	typeVersion?: number;
	position?: [number, number];
	parameters?: JsonObject;
	credentials?: Record<string, CredentialReferenceDocument>;
	disabled?: boolean;
	onError?: 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow' | string;
	continueOnFail?: boolean;
	retryOnFail?: boolean;
	maxTries?: number;
	waitBetweenTries?: number;
	executeOnce?: boolean;
	alwaysOutputData?: boolean;
}

export interface CredentialReferenceDocument extends JsonObject {
	id?: string;
	name: string;
}

export interface WorkflowConnectionDocument {
	node: string;
	type: string;
	index: number;
}

export type WorkflowConnectionsDocument = Record<
	string,
	Record<string, Array<Array<WorkflowConnectionDocument> | null>>
>;

export interface WorkflowDocument extends JsonObject {
	id?: string;
	name: string;
	active?: boolean;
	nodes: WorkflowNodeDocument[];
	connections?: WorkflowConnectionsDocument;
	settings?: JsonObject;
}

export interface WorkflowConnection {
	source: WorkflowNodeDocument;
	target: WorkflowNodeDocument;
	sourceType: string;
	sourceOutput: number;
	targetType: string;
	targetInput: number;
}

export interface WorkflowGraph {
	document: WorkflowDocument;
	nodesByName: Map<string, WorkflowNodeDocument>;
	connections: WorkflowConnection[];
	incoming: Map<string, WorkflowConnection[]>;
	outgoing: Map<string, WorkflowConnection[]>;
	legacyLinear: boolean;
}

export class WorkflowFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkflowFormatError';
	}
}

/** Validate the known shape while returning a deep copy with all unknown fields intact. */
export function parseWorkflowDocument(input: unknown): WorkflowDocument {
	if (!isObject(input)) throw new WorkflowFormatError('Workflow must be a JSON object');
	const document = structuredClone(input) as JsonObject;
	if (typeof document.name !== 'string' || document.name.trim().length === 0) {
		throw new WorkflowFormatError('Workflow name must be a non-empty string');
	}
	if (!Array.isArray(document.nodes)) throw new WorkflowFormatError('Workflow nodes must be an array');

	const nodes = document.nodes.map((value, index) => {
		if (!isObject(value)) throw new WorkflowFormatError(`Node ${index + 1} must be a JSON object`);
		const node = value as JsonObject;
		if (typeof node.id !== 'string' || node.id.length === 0) {
			throw new WorkflowFormatError(`Node ${index + 1} needs an id`);
		}
		if (typeof node.name !== 'string' || node.name.length === 0) {
			throw new WorkflowFormatError(`Node ${index + 1} needs a name`);
		}
		if (typeof node.type !== 'string' || node.type.length === 0) {
			throw new WorkflowFormatError(`Node ${index + 1} needs a type`);
		}
		if (node.typeVersion !== undefined && (!Number.isFinite(node.typeVersion) || Number(node.typeVersion) <= 0)) {
			throw new WorkflowFormatError(`Node ${node.name} has an invalid typeVersion`);
		}
		if (node.position !== undefined && (!Array.isArray(node.position) || node.position.length !== 2 || node.position.some((part) => !Number.isFinite(part)))) {
			throw new WorkflowFormatError(`Node ${node.name} has an invalid position`);
		}
		if (node.parameters !== undefined && !isObject(node.parameters)) {
			throw new WorkflowFormatError(`Node ${node.name} parameters must be a JSON object`);
		}
		return node as WorkflowNodeDocument;
	});

	if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
		throw new WorkflowFormatError('Node IDs must be unique');
	}
	if (document.connections !== undefined && !isObject(document.connections)) {
		throw new WorkflowFormatError('Workflow connections must be an object');
	}
	document.nodes = nodes;
	return document as WorkflowDocument;
}

/**
 * Convert a validated document into a graph without changing the stored JSON.
 * Squared 0.1 workflows had implicit array-order edges; those are synthesized
 * only for that legacy node type family.
 */
export function buildWorkflowGraph(input: unknown): WorkflowGraph {
	const document = parseWorkflowDocument(input);
	const nodesByName = new Map<string, WorkflowNodeDocument>();
	for (const node of document.nodes) {
		if (nodesByName.has(node.name)) throw new WorkflowFormatError(`Duplicate node name: ${node.name}`);
		nodesByName.set(node.name, node);
	}

	const incoming = new Map<string, WorkflowConnection[]>();
	const outgoing = new Map<string, WorkflowConnection[]>();
	const connections: WorkflowConnection[] = [];
	const legacyLinear = document.connections === undefined && isLegacyLinear(document.nodes);

	const addConnection = (connection: WorkflowConnection) => {
		connections.push(connection);
		const incomingConnections = incoming.get(connection.target.name) ?? [];
		incomingConnections.push(connection);
		incoming.set(connection.target.name, incomingConnections);
		const outgoingConnections = outgoing.get(connection.source.name) ?? [];
		outgoingConnections.push(connection);
		outgoing.set(connection.source.name, outgoingConnections);
	};

	if (legacyLinear) {
		for (let index = 0; index < document.nodes.length - 1; index += 1) {
			const source = document.nodes[index];
			const target = document.nodes[index + 1];
			if (source && target) {
				addConnection({ source, target, sourceType: 'main', sourceOutput: 0, targetType: 'main', targetInput: 0 });
			}
		}
	} else {
		for (const [sourceName, connectionTypes] of Object.entries(document.connections ?? {})) {
			const source = nodesByName.get(sourceName);
			if (!source) throw new WorkflowFormatError(`Connections refer to missing source node: ${sourceName}`);
			for (const [sourceType, outputPorts] of Object.entries(connectionTypes)) {
				if (!Array.isArray(outputPorts)) {
					throw new WorkflowFormatError(`Connections for ${sourceName}.${sourceType} must be an array`);
				}
				for (let sourceOutput = 0; sourceOutput < outputPorts.length; sourceOutput += 1) {
					for (const link of outputPorts[sourceOutput] ?? []) {
						if (!isObject(link) || typeof link.node !== 'string' || typeof link.type !== 'string') {
							throw new WorkflowFormatError(`Invalid connection from ${sourceName}`);
						}
						if (!Number.isInteger(link.index) || Number(link.index) < 0) {
							throw new WorkflowFormatError(`Invalid input index from ${sourceName} to ${link.node}`);
						}
						const target = nodesByName.get(link.node);
						if (!target) throw new WorkflowFormatError(`Connections refer to missing node: ${link.node}`);
						addConnection({
							 source, target, sourceType, sourceOutput, targetType: link.type, targetInput: Number(link.index),
						});
					}
				}
			}
		}
	}

	return { document, nodesByName, connections, incoming, outgoing, legacyLinear };
}

function isLegacyLinear(nodes: WorkflowNodeDocument[]): boolean {
	return nodes.length > 0 && nodes.every((node) =>
		['trigger.manual', 'trigger.webhook', 'trigger.schedule', 'data.set', 'http.request', 'logic.if'].includes(node.type),
	);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
