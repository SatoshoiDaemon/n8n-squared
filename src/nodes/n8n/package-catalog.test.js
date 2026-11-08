import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { N8nPackageCatalog } from './package-catalog.ts';

test('catalog discovers node and credential descriptions without importing package code', async () => {
	const root = await mkdtemp(join(tmpdir(), 'squared-node-catalog-'));
	const packageDir = join(root, 'n8n-nodes-demo');
	const nodeDir = join(packageDir, 'dist', 'nodes', 'Example');
	const credentialDir = join(packageDir, 'dist', 'credentials');
	await mkdir(nodeDir, { recursive: true });
	await mkdir(credentialDir, { recursive: true });
	await writeFile(join(packageDir, 'package.json'), JSON.stringify({
		name: 'n8n-nodes-demo', version: '1.2.3', license: 'LicenseRef-n8n-sustainable-use', dependencies: { 'node-fetch': '^3.0.0' },
		n8n: {
			nodes: ['dist/nodes/Example/Example.node.js', 'dist/nodes/Example/ExampleEnterprise.node.ee.js'],
			credentials: ['dist/credentials/DemoApi.credentials.js'],
		},
	}));
	await writeFile(join(nodeDir, 'Example.node.js'), "throw new Error('node implementation must not be imported');\n");
	await writeFile(join(nodeDir, 'ExampleEnterprise.node.ee.js'), "throw new Error('enterprise node must not be imported');\n");
	await writeFile(join(nodeDir, 'Example.node.json'), JSON.stringify({ node: {
		name: 'n8n-nodes-demo.example', displayName: 'Example', version: 2,
		requestDefaults: { baseURL: 'https://example.test' }, properties: [{ name: 'resource', type: 'options' }],
	} }));
	await writeFile(join(nodeDir, 'ExampleEnterprise.node.ee.json'), JSON.stringify({ node: {
		name: 'n8n-nodes-demo.exampleEnterprise', displayName: 'Enterprise Example', version: 1, properties: [],
	} }));
	await writeFile(join(credentialDir, 'DemoApi.credentials.js'), "throw new Error('credential implementation must not be imported');\n");
	await writeFile(join(credentialDir, 'DemoApi.credentials.json'), JSON.stringify({ credential: {
		name: 'demoApi', displayName: 'Demo API', properties: [{ name: 'token', type: 'string' }],
	} }));

	try {
		const catalog = new N8nPackageCatalog(root);
		const discovered = await catalog.discover();
		assert.equal(discovered.nodes.length, 2);
		assert.equal(discovered.nodes[0].compatibility.discovered, true);
		assert.equal(discovered.nodes[0].compatibility.loaded, false);
		const loaded = await catalog.loadDescriptions();
		assert.equal(loaded.nodes[0].nodeType, 'n8n-nodes-demo.example');
		assert.equal(loaded.nodes[0].executionType, 'declarative');
		assert.equal(loaded.nodes[0].compatibility.configurable, true);
		assert.equal(loaded.nodes[0].compatibility.executable, false);
		const enterprise = loaded.nodes.find((node) => node.enterpriseRestricted);
		assert.equal(enterprise.license, 'LicenseRef-n8n-enterprise');
		assert.equal(enterprise.compatibility.loaded, false);
		assert.equal(enterprise.description, undefined);
		assert.equal(loaded.credentials[0].configurable, true);
		assert.throws(() => catalog.assertExecutable('n8n-nodes-demo.example'), /has not passed runtime loading and execution-contract checks/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
