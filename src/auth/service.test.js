import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAuthService } from './service.js';
import { loadOrCreateEncryptionKey } from '../persistence/persistent-secrets.js';
import { SqliteStore } from '../persistence/sqlite.js';

test('first-admin claim is atomic and the authenticated session survives a store restart', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'squared-auth-'));
	let store = new SqliteStore(dataDir);
	await store.connect();
	const auth = new AdminAuthService({ store, dataDir });
	await auth.initialize();
	const bootstrapCode = await readFile(join(dataDir, 'bootstrap-code'), 'utf8');
	const claims = await Promise.allSettled([
		auth.bootstrap({ code: bootstrapCode, email: 'first@example.test', password: 'first-strong-password-123' }),
		auth.bootstrap({ code: bootstrapCode, email: 'second@example.test', password: 'second-strong-password-123' }),
	]);
	assert.equal(claims.filter((claim) => claim.status === 'fulfilled').length, 1);
	assert.equal(claims.filter((claim) => claim.status === 'rejected' && claim.reason.statusCode === 409).length, 1);
	const winner = claims.find((claim) => claim.status === 'fulfilled').value;
	assert.equal((await store.getAdmin()).email, winner.email);
	assert.equal((await auth.status(winner.sessionToken)).authenticated, true);
	await store.close();

	store = new SqliteStore(dataDir);
	await store.connect();
	const restartedAuth = new AdminAuthService({ store, dataDir });
	await restartedAuth.initialize();
	assert.deepEqual(await restartedAuth.status(winner.sessionToken), { setupRequired: false, authenticated: true });
	assert.equal(await readFile(join(dataDir, 'bootstrap-code')).then(() => true, () => false), false);
	await store.close();
	await rm(dataDir, { recursive: true, force: true });
});

test('generated encryption key is stable and a different override cannot replace it', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'squared-key-'));
	try {
		const generated = await loadOrCreateEncryptionKey(dataDir);
		assert.equal(generated.length >= 32, true);
		assert.equal(await loadOrCreateEncryptionKey(dataDir), generated);
		await assert.rejects(loadOrCreateEncryptionKey(dataDir, 'a-different-key-that-is-long-enough'), /does not match the persisted key/);
		assert.equal(await loadOrCreateEncryptionKey(dataDir), generated);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});
