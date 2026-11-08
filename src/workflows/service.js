import { randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeWorkflow } from './definition.js';
import { buildWorkflowGraph } from './n8n-format.ts';
import { RequestError } from '../errors.js';

export class WorkflowService {
	constructor(store, executionEngine, n8nNodeRuntime, credentialProvider) {
		this.store = store;
		this.executionEngine = executionEngine;
		this.n8nNodeRuntime = n8nNodeRuntime;
		this.credentialProvider = credentialProvider;
		this.webhookRoutes = [];
		this.nextPollAt = new Map();
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
			const saved = await this.store.saveWorkflow(normalizeWorkflow(input, id || input.id || randomUUID()));
			await this.reconcileTriggers();
			return saved;
		} catch (error) {
			if (!error.statusCode) error.statusCode = 400;
			throw error;
		}
	}

	async importN8nWorkflow(input) {
		let graph;
		try {
			graph = buildWorkflowGraph(input);
		} catch (error) {
			if (!error.statusCode) error.statusCode = 400;
			throw error;
		}
		const id = typeof graph.document.id === 'string' && graph.document.id ? graph.document.id : randomUUID();
		try {
			const saved = await this.store.createWorkflow({ ...graph.document, id });
			await this.reconcileTriggers();
			return saved;
		} catch (error) {
			if (await this.store.getWorkflow(id)) throw new RequestError(409, 'Workflow ID already exists; import was not applied');
			throw error;
		}
	}

	async exportN8nWorkflow(id) {
		const definition = await this.store.getWorkflowDefinition(id);
		if (!definition) throw new RequestError(404, 'Workflow not found');
		return definition;
	}

	async remove(id) {
		const deleted = await this.store.deleteWorkflow(id);
		if (!deleted) throw new RequestError(404, 'Workflow not found');
		await this.reconcileTriggers();
	}

	async setActive(id, active) {
		const workflow = await this.get(id);
		const saved = await this.store.saveWorkflow({ ...workflow, active: Boolean(active) });
		await this.reconcileTriggers();
		return saved;
	}

	async execute(id, triggerType, input = {}, triggerOptions = {}) {
		const workflow = await this.get(id);
		if (triggerType !== 'manual' && !workflow.active) throw new RequestError(409, 'Workflow is inactive');
		if (isN8nWorkflow(workflow)) {
			let graph;
			try { graph = buildWorkflowGraph(workflow); }
			catch (error) { throw new RequestError(409, `Workflow graph is invalid: ${error.message}`); }
			const roots = graph.document.nodes.filter((node) => (graph.incoming.get(node.name) ?? []).length === 0);
			const matchingRoots = roots.filter((node) => matchesN8nTrigger(node, triggerType) &&
				(!triggerOptions.webhookNodeName || node.name === triggerOptions.webhookNodeName));
			if (matchingRoots.length !== 1) {
				throw new RequestError(409, `Workflow must have exactly one ${triggerType} trigger with no incoming connections`);
			}
			if (triggerType === 'webhook' && triggerOptions.webhookRequest && this.executionEngine.executeWebhook) {
				return this.executionEngine.executeWebhook(workflow, matchingRoots[0].name, input, triggerOptions.webhookRequest);
			}
			return this.executionEngine.submit(workflow, triggerType, input, {
				startNode: matchingRoots[0].name,
				...(triggerOptions.webhookRequest ? { webhookRequest: triggerOptions.webhookRequest } : {}),
			});
		}
		const trigger = workflow.nodes[0].type;
		const expectedType = `trigger.${triggerType}`;
		if (trigger !== expectedType) throw new RequestError(409, `Workflow does not use ${triggerType} trigger`);
		return this.executionEngine.submit(workflow, triggerType, input);
	}

	resumeDueWaits(now) {
		return this.executionEngine.resumeDueWaits(now);
	}

	resumeExecution(id, input) {
		return this.executionEngine.resumeWaitingExecution(id, input);
	}

	async reconcileTriggers() {
		const entries = [];
		for (const workflow of await this.store.listWorkflows?.() ?? []) {
			if (!workflow.active || !isN8nWorkflow(workflow)) continue;
			const graph = buildWorkflowGraph(workflow);
			for (const node of graph.document.nodes) {
				if ((graph.incoming.get(node.name) ?? []).length !== 0) continue;
				const capabilities = await getNodeCapabilities(this.n8nNodeRuntime, node);
				if (capabilities?.trigger) entries.push({ workflow, node });
			}
		}
		const active = await this.executionEngine.reconcileTriggers?.(entries) ?? 0;
		await this.reconcileWebhooks();
		return active;
	}

	async reconcileWebhooks() {
		const routes = [];
		for (const workflow of await this.store.listWorkflows?.() ?? []) {
			if (!workflow.active || !isN8nWorkflow(workflow)) continue;
			const graph = buildWorkflowGraph(workflow);
			for (const node of graph.document.nodes) {
				if ((graph.incoming.get(node.name) ?? []).length !== 0) continue;
				const capabilities = await getNodeCapabilities(this.n8nNodeRuntime, node);
				if (!capabilities?.webhook) continue;
				const description = capabilities.description;
				const definitions = Array.isArray(description.webhooks) ? description.webhooks : [];
				for (const definition of definitions) {
					const parameters = node.parameters ?? {};
					const configuredPath = resolveWebhookExpression(definition?.path, parameters) ?? parameters.path;
					const rawPath = typeof configuredPath === 'string' && configuredPath.trim()
						? configuredPath.trim().replace(/^\/+|\/+$/g, '')
						: '';
					const dynamicPath = /(^|\/)\s*:[A-Za-z_][A-Za-z0-9_]*/.test(rawPath);
					const isFullPath = resolveWebhookExpression(definition?.isFullPath, parameters) !== false;
					const pathSegments = [
						'webhook',
						...(node.webhookId === undefined
							? [String(workflow.id), encodeURIComponent(node.name.toLowerCase()), rawPath]
							: dynamicPath
								? [String(node.webhookId), rawPath]
								: isFullPath
									? [rawPath || String(node.webhookId)]
									: [String(node.webhookId), rawPath]),
					].flatMap((part) => String(part).split('/')).filter(Boolean);
					const routePath = `/${pathSegments.join('/')}`;
					const configuredMethod = resolveWebhookExpression(definition?.httpMethod, parameters) ?? parameters.httpMethod ?? 'GET';
					const methods = parameters.multipleMethods
						? (Array.isArray(configuredMethod) ? configuredMethod : [configuredMethod])
						: [Array.isArray(configuredMethod) ? configuredMethod[0] : configuredMethod];
					for (const method of methods) {
						const normalizedMethod = String(method).toUpperCase();
						if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) continue;
						routes.push({
							workflowId: workflow.id,
							nodeName: node.name,
							node,
							method: normalizedMethod,
							path: routePath,
							matcher: compileWebhookPath(routePath),
						});
					}
				}
			}
		}
		const unique = new Set();
		for (const route of routes) {
			const key = `${route.method}:${route.path}`;
			if (unique.has(key)) throw new RequestError(409, `Active webhook path is already registered: ${route.method} ${route.path}`);
			unique.add(key);
		}
		this.webhookRoutes = routes;
		return routes.length;
	}

	resolveWebhook(method, pathname) {
		const normalizedMethod = String(method).toUpperCase();
		for (const route of this.webhookRoutes) {
			if (route.method !== normalizedMethod) continue;
			const match = route.matcher.regexp.exec(pathname);
			if (!match) continue;
			const params = Object.fromEntries(route.matcher.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
			return { ...route, params };
		}
		return null;
	}

	async authorizeWebhook(route, request) {
		const authentication = String(route.node.parameters?.authentication ?? 'none');
		if (authentication === 'none') return true;
		const credentialType = ({ basicAuth: 'httpBasicAuth', headerAuth: 'httpHeaderAuth', jwtAuth: 'jwtAuth' })[authentication];
		const reference = credentialType ? route.node.credentials?.[credentialType] : undefined;
		if (!credentialType || !reference || !this.credentialProvider) return false;
		const credentials = await this.credentialProvider(reference, credentialType, route.node);
		if (!credentials) return false;
		if (authentication === 'basicAuth') {
			const supplied = String(request.headers.authorization ?? '');
			if (!supplied.startsWith('Basic ')) return false;
			let decoded;
			try { decoded = Buffer.from(supplied.slice(6), 'base64').toString('utf8'); } catch { return false; }
			return secureStringEqual(decoded, `${credentials.user ?? ''}:${credentials.password ?? ''}`);
		}
		if (authentication === 'headerAuth') {
			const name = String(credentials.name ?? '').toLowerCase();
			const supplied = request.headers[name];
			return typeof supplied === 'string' && secureStringEqual(supplied, String(credentials.value ?? ''));
		}
		return false;
	}

	async pollActiveWorkflows(now = Date.now()) {
		let submitted = 0;
		const activePolls = new Set();
		for (const workflow of await this.store.listWorkflows?.() ?? []) {
			if (!workflow.active || !isN8nWorkflow(workflow)) continue;
			const graph = buildWorkflowGraph(workflow);
			for (const node of graph.document.nodes) {
				if ((graph.incoming.get(node.name) ?? []).length !== 0) continue;
				const capabilities = await getNodeCapabilities(this.n8nNodeRuntime, node);
				if (!capabilities?.poll) continue;
				const key = `${workflow.id}:${node.id}`;
				activePolls.add(key);
				if ((this.nextPollAt.get(key) ?? 0) > now) continue;
				await this.executionEngine.submit(workflow, 'poll', {}, { startNode: node.name });
				this.nextPollAt.set(key, now + pollIntervalMs(node));
				submitted += 1;
			}
		}
		for (const key of this.nextPollAt.keys()) if (!activePolls.has(key)) this.nextPollAt.delete(key);
		return submitted;
	}

	async deactivateAllTriggers() {
		return this.executionEngine.deactivateAllTriggers?.();
	}
}

function isN8nWorkflow(workflow) {
	return Boolean((workflow.connections && typeof workflow.connections === 'object') ||
		workflow.nodes?.some((node) => typeof node.type === 'string' && node.type.startsWith('n8n-nodes-')));
}

function matchesN8nTrigger(node, triggerType) {
	if (typeof node.type !== 'string') return false;
	const name = node.type.slice(node.type.lastIndexOf('.') + 1).toLowerCase();
	if (triggerType === 'manual') return name === 'manualtrigger' || name === 'executeworkflowtrigger';
	if (triggerType === 'webhook') return name === 'webhook' || name === 'webhooktrigger';
	if (triggerType === 'schedule') return name === 'scheduletrigger' || name === 'cron';
	if (triggerType === 'poll') return true;
	return false;
}

function resolveWebhookExpression(value, parameters) {
	if (typeof value !== 'string') return value;
	const parameterReference = value.match(/^=\{\{\s*\$parameter\[(["'])([^"']+)\1\](?:\s*\|\|\s*(["'])([^"']*)\3)?\s*\}\}$/);
	return parameterReference ? parameters[parameterReference[2]] ?? parameterReference[4] : value;
}

function compileWebhookPath(path) {
	const names = [];
	const escaped = path.split('/').map((segment) => {
		if (segment.startsWith(':') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.slice(1))) {
			names.push(segment.slice(1));
			return '([^/]+)';
		}
		return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}).join('/');
	return { names, regexp: new RegExp(`^${escaped}/?$`) };
}

function secureStringEqual(left, right) {
	const first = Buffer.from(String(left));
	const second = Buffer.from(String(right));
	return first.length === second.length && timingSafeEqual(first, second);
}

async function getNodeCapabilities(runtime, node) {
	if (!runtime?.getNodeCapabilities) return null;
	try {
		return await runtime.getNodeCapabilities(node.type, node.typeVersion);
	} catch (error) {
		console.error(`Could not load active n8n node ${node.type}@${node.typeVersion ?? 1}`, error?.name || 'Error', error?.code || 'unknown');
		return null;
	}
}

function pollIntervalMs(node) {
	const explicit = Number(node.parameters?.pollIntervalMs);
	if (Number.isFinite(explicit) && explicit >= 1_000) return Math.min(explicit, 86_400_000);
	const item = node.parameters?.pollTimes?.item;
	const schedule = Array.isArray(item) ? item[0] : undefined;
	if (schedule?.mode === 'everyMinute') return 60_000;
	if (schedule?.mode === 'everyX') {
		const value = Number(schedule.value ?? schedule.amount ?? 1);
		const unit = String(schedule.unit ?? 'minutes').toLowerCase();
		const multiplier = unit.startsWith('second') ? 1_000 : unit.startsWith('hour') ? 3_600_000 : unit.startsWith('day') ? 86_400_000 : 60_000;
		if (Number.isFinite(value) && value > 0) return Math.min(Math.max(1_000, value * multiplier), 86_400_000);
	}
	return 60_000;
}
