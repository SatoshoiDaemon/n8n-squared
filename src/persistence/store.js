import { PostgresStore } from './postgres.js';
import { SqliteStore } from './sqlite.js';

export function createStore(config) {
	return config.databaseUrl ? new PostgresStore(config) : new SqliteStore(config.dataDir);
}
