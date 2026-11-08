import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowService } from './service.js';

test('active n8n webhook routes register from the published description and unregister on deactivation', async () => {
	const workflow = {
		id: 'workflow-webhook',
		name: 'Webhook workflow',
		active: true,
		nodes: [{
			id: 'node-webhook',
			webhookId: 'stable-webhook-id',
			name: 'Orders',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 1.1,
			parameters: { httpMethod: 'POST', path: 'orders/:orderId', authentication: 'none' },
		}],
		connections: {},
	};
	const store = { async listWorkflows() { return [workflow]; } };
	const runtime = {
		getSnapshot() { return { nodes: [{ nodeType: 'n8n-nodes-base.webhook', executionType: 'webhook' }] }; },
		async getNodeCapabilities() {
			return { trigger: false, poll: false, webhook: true, description: { webhooks: [{ name: 'default', isFullPath: true, httpMethod: '={{$parameter["httpMethod"]}}', path: '={{$parameter["path"]}}' }] } };
		},
	};
	const service = new WorkflowService(store, { async reconcileTriggers() { return 0; } }, runtime);

	assert.equal(await service.reconcileWebhooks(), 1);
	const route = service.resolveWebhook('POST', '/webhook/stable-webhook-id/orders/ORD-42');
	assert.equal(route.workflowId, workflow.id);
	assert.equal(route.nodeName, 'Orders');
	assert.deepEqual(route.params, { orderId: 'ORD-42' });
	assert.equal(service.resolveWebhook('GET', '/webhook/stable-webhook-id/orders/ORD-42'), null);

	workflow.active = false;
	await service.reconcileTriggers();
	assert.equal(service.resolveWebhook('POST', '/webhook/stable-webhook-id/orders/ORD-42'), null);
});

test('webhook basic and header authentication uses the configured Squared credential provider', async () => {
	const workflow = {
		id: 'workflow-auth',
		name: 'Authenticated webhook',
		active: true,
		nodes: [{
			id: 'node-auth',
			webhookId: 'auth-webhook-id',
			name: 'Webhook',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 1.1,
			parameters: { httpMethod: 'POST', path: 'secure', authentication: 'headerAuth' },
			credentials: { httpHeaderAuth: { id: 'header-credential', name: 'Header credential' } },
		}],
		connections: {},
	};
	const store = { async listWorkflows() { return [workflow]; } };
	const runtime = {
		getSnapshot() { return { nodes: [{ nodeType: 'n8n-nodes-base.webhook', executionType: 'webhook' }] }; },
		async getNodeCapabilities() {
			return { trigger: false, poll: false, webhook: true, description: { webhooks: [{ name: 'default', isFullPath: true, httpMethod: '={{$parameter["httpMethod"]}}', path: '={{$parameter["path"]}}' }] } };
		},
	};
	const service = new WorkflowService(store, { async reconcileTriggers() { return 0; } }, runtime, async (reference, type) => {
		assert.equal(reference.id, 'header-credential');
		assert.equal(type, 'httpHeaderAuth');
		return { name: 'x-squared-token', value: 'fixture-secret' };
	});
	await service.reconcileWebhooks();
	const route = service.resolveWebhook('POST', '/webhook/secure');
	assert.equal(await service.authorizeWebhook(route, { headers: { 'x-squared-token': 'wrong' } }), false);
	assert.equal(await service.authorizeWebhook(route, { headers: { 'x-squared-token': 'fixture-secret' } }), true);
});

test('polling respects the node interval and avoids repeated scheduler submissions', async () => {
	const workflow = {
		id: 'workflow-poll',
		name: 'Polling workflow',
		active: true,
		nodes: [{ id: 'rss', name: 'RSS', type: 'n8n-nodes-base.rssFeedReadTrigger', typeVersion: 1, parameters: { pollTimes: { item: [{ mode: 'everyX', value: 2, unit: 'minutes' }] } } }],
		connections: {},
	};
	let submitted = 0;
	const runtime = { async getNodeCapabilities() { return { trigger: false, poll: true, webhook: false }; } };
	const service = new WorkflowService(
		{ async listWorkflows() { return [workflow]; } },
		{ async submit() { submitted += 1; return { id: String(submitted), status: 'queued' }; } },
		runtime,
	);
	assert.equal(await service.pollActiveWorkflows(10_000), 1);
	assert.equal(await service.pollActiveWorkflows(129_999), 0);
	assert.equal(await service.pollActiveWorkflows(130_000), 1);
	assert.equal(submitted, 2);
});
