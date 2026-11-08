import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const secrets = {
	SQUARED_DATABASE_URL: 'postgresql://user:pass@localhost:5432/squared',
	SQUARED_ENCRYPTION_KEY: 'x'.repeat(40),
	SQUARED_ACCESS_TOKEN: 't'.repeat(32),
};

test('runtime config defaults to one active execution and bounded queue', () => {
	const config = loadConfig(secrets);
	assert.equal(config.port, 80);
	assert.equal(config.host, '0.0.0.0');
	assert.equal(config.maxConcurrency, 1);
	assert.equal(config.maxQueuedExecutions, 16);
	assert.equal(config.databaseUrl, secrets.SQUARED_DATABASE_URL);
	assert.equal(loadConfig({ ...secrets, PORT: '1234', SQUARED_PORT: '4321' }).port, 4321);
});

test('runtime config rejects missing secrets and unsafe limits', () => {
	assert.throws(() => loadConfig({ ...secrets, SQUARED_ACCESS_TOKEN: '' }), /SQUARED_ACCESS_TOKEN/);
	assert.throws(() => loadConfig({ ...secrets, SQUARED_MAX_CONCURRENCY: '9' }), /SQUARED_MAX_CONCURRENCY/);
	assert.throws(() => loadConfig({ ...secrets, PORT: '70000' }), /PORT/);
});
