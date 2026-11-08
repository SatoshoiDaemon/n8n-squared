import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULTS = {
	port: 80,
	host: '0.0.0.0',
	maxConcurrency: 1,
	maxQueuedExecutions: 16,
	schedulePollMs: 5_000,
	requestTimeoutMs: 15_000,
	maxRequestBytes: 1_048_576,
	maxResponseBytes: 5_242_880,
};

function integer(name, value, fallback, { min, max }) {
	const parsed = value === undefined || value === '' ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer from ${min} to ${max}`);
	}
	return parsed;
}
export function loadConfig(env = process.env) {
	const databaseUrl = env.SQUARED_DATABASE_URL || env.DATABASE_URL;
	if (databaseUrl) {
		let protocol;
		try {
			protocol = new URL(databaseUrl).protocol;
		} catch {
			throw new Error('SQUARED_DATABASE_URL must be a valid PostgreSQL URL');
		}
		if (!['postgres:', 'postgresql:'].includes(protocol)) {
			throw new Error('SQUARED_DATABASE_URL must use PostgreSQL');
		}
	}
	if (env.SQUARED_ENCRYPTION_KEY && env.SQUARED_ENCRYPTION_KEY.length < 32) {
		throw new Error('SQUARED_ENCRYPTION_KEY must contain at least 32 characters and remain stable between deploys');
	}
	if (env.SQUARED_ACCESS_TOKEN && env.SQUARED_ACCESS_TOKEN.length < 24) {
		throw new Error('SQUARED_ACCESS_TOKEN must contain at least 24 characters');
	}
	const dataDir = resolve(env.SQUARED_DATA_DIR || join(process.cwd(), 'squared-data'));
	const temporaryRoot = resolve(tmpdir());
	const relativeToTemp = relative(temporaryRoot, dataDir);
	if (
		!isAbsolute(relativeToTemp) &&
		(relativeToTemp === '' || (relativeToTemp !== '..' && !relativeToTemp.startsWith(`..${sep}`)))
	) {
		throw new Error('SQUARED_DATA_DIR cannot be inside the operating system temporary directory');
	}

	const port = integer('SQUARED_PORT', env.SQUARED_PORT ?? env.PORT, DEFAULTS.port, { min: 1, max: 65535 });
	const maxConcurrency = integer('SQUARED_MAX_CONCURRENCY', env.SQUARED_MAX_CONCURRENCY, DEFAULTS.maxConcurrency, {
		min: 1,
		max: 8,
	});
	const maxQueuedExecutions = integer(
		'SQUARED_MAX_QUEUED_EXECUTIONS',
		env.SQUARED_MAX_QUEUED_EXECUTIONS,
		DEFAULTS.maxQueuedExecutions,
		{ min: maxConcurrency, max: 1_024 },
	);
	const schedulePollMs = integer(
		'SQUARED_SCHEDULE_POLL_MS',
		env.SQUARED_SCHEDULE_POLL_MS,
		DEFAULTS.schedulePollMs,
		{ min: 1_000, max: 60_000 },
	);
	const requestTimeoutMs = integer(
		'SQUARED_HTTP_TIMEOUT_MS',
		env.SQUARED_HTTP_TIMEOUT_MS,
		DEFAULTS.requestTimeoutMs,
		{ min: 100, max: 120_000 },
	);

	return Object.freeze({
		port,
		host: env.SQUARED_HOST || DEFAULTS.host,
		dataDir,
		databaseUrl,
		databaseSsl: env.SQUARED_DATABASE_SSL === 'require',
		encryptionKey: env.SQUARED_ENCRYPTION_KEY || undefined,
		accessToken: env.SQUARED_ACCESS_TOKEN || undefined,
		maxConcurrency,
		maxQueuedExecutions,
		schedulePollMs,
		requestTimeoutMs,
		maxRequestBytes: DEFAULTS.maxRequestBytes,
		maxResponseBytes: DEFAULTS.maxResponseBytes,
	});
}
