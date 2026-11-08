import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

test('runtime defaults to local SQLite storage without runtime secrets', () => {
	const config = loadConfig({});
	assert.equal(config.port, 80);
	assert.equal(config.host, '0.0.0.0');
	assert.equal(config.maxConcurrency, 1);
	assert.equal(config.maxQueuedExecutions, 16);
	assert.equal(config.databaseUrl, undefined);
	assert.equal(config.encryptionKey, undefined);
	assert.equal(config.accessToken, undefined);
	assert.equal(config.dataDir.endsWith('squared-data'), true);
});

test('PostgreSQL and stable advanced secrets remain optional overrides', () => {
	const config = loadConfig({
		SQUARED_DATABASE_URL: 'postgresql://user:pass@localhost:5432/squared',
		SQUARED_ENCRYPTION_KEY: 'x'.repeat(40),
		SQUARED_ACCESS_TOKEN: 't'.repeat(32),
		PORT: '1234',
		SQUARED_PORT: '4321',
	});
	assert.equal(config.databaseUrl, 'postgresql://user:pass@localhost:5432/squared');
	assert.equal(config.encryptionKey, 'x'.repeat(40));
	assert.equal(config.accessToken, 't'.repeat(32));
	assert.equal(config.port, 4321);
});

test('runtime config still rejects malformed optional settings and unsafe limits', () => {
	assert.throws(() => loadConfig({ SQUARED_DATABASE_URL: 'https://example.test/db' }), /must use PostgreSQL/);
	assert.throws(() => loadConfig({ SQUARED_ENCRYPTION_KEY: 'short' }), /SQUARED_ENCRYPTION_KEY/);
	assert.throws(() => loadConfig({ SQUARED_ACCESS_TOKEN: 'short' }), /SQUARED_ACCESS_TOKEN/);
	assert.throws(() => loadConfig({ SQUARED_MAX_CONCURRENCY: '9' }), /SQUARED_MAX_CONCURRENCY/);
	assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
	assert.throws(() => loadConfig({ SQUARED_DATA_DIR: join(tmpdir(), 'squared-data') }), /temporary directory/);
});
