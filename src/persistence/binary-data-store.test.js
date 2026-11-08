import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentBinaryDataStore } from './binary-data-store.js';

test('persistent binary storage retrieves files by opaque ID and rejects paths', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'squared-binary-store-'));
	try {
		const store = new PersistentBinaryDataStore(directory);
		const payload = Buffer.from('binary fixture');
		const id = await store.store(payload);
		assert.deepEqual(await store.retrieve(id), payload);
		await assert.rejects(store.retrieve('../outside'), /Invalid Squared binary data identifier/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
