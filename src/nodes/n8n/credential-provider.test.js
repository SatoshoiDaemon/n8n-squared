import test from 'node:test';
import assert from 'node:assert/strict';
import { createSquaredCredentialProvider } from './credential-provider.ts';

test('credential references resolve by ID from Squared storage and are decrypted only at execution', async () => {
	const calls = [];
	const provider = createSquaredCredentialProvider({
		async getCredential(id) {
			calls.push(['store', id]);
			return { id, name: 'Saved token', encryptedValue: 'v1.encrypted' };
		},
	}, {
		open(value) {
			calls.push(['vault', value]);
			return { token: 'secret-value' };
		},
	});
	const credential = await provider({ id: 'credential-1', name: 'Saved token' }, 'demoApi', { id: 'node-1', name: 'Node', type: 'n8n-nodes-demo.example' });
	assert.deepEqual(credential, { token: 'secret-value' });
	assert.deepEqual(calls, [['store', 'credential-1'], ['vault', 'v1.encrypted']]);
});

test('credential names alone do not resolve an ambiguous secret', async () => {
	let called = false;
	const provider = createSquaredCredentialProvider({ async getCredential() { called = true; return null; } }, { open() { throw new Error('not called'); } });
	assert.equal(await provider({ name: 'Same name' }, 'demoApi', { id: 'n', name: 'Node', type: 'demo' }), null);
	assert.equal(called, false);
});
