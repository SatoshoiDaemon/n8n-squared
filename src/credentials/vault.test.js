import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialVault } from './vault.js';

test('credentials are encrypted and authenticated with a stable secret', () => {
	const value = { Authorization: 'Bearer private-token', retries: 2 };
	const secret = 'a stable secret with more than 32 characters';
	const sealed = new CredentialVault(secret).seal(value);
	assert.equal(sealed.includes('private-token'), false);
	assert.deepEqual(new CredentialVault(secret).open(sealed), value);
	assert.throws(() => new CredentialVault('a different stable secret with more than 32 characters').open(sealed));
});
