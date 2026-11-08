CREATE TABLE IF NOT EXISTS squared_workflows (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	active INTEGER NOT NULL DEFAULT 0,
	definition TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS squared_executions (
	id TEXT PRIMARY KEY,
	workflow_id TEXT NOT NULL,
	trigger_type TEXT NOT NULL,
	status TEXT NOT NULL,
	input TEXT NOT NULL DEFAULT '{}',
	output TEXT,
	error TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	started_at TEXT,
	finished_at TEXT
);

CREATE INDEX IF NOT EXISTS squared_executions_workflow_created_idx
	ON squared_executions (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS squared_credentials (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	encrypted_value TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS squared_admins (
	admin_id TEXT PRIMARY KEY CHECK (admin_id = 'owner'),
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS squared_sessions (
	token_hash TEXT PRIMARY KEY,
	admin_id TEXT NOT NULL REFERENCES squared_admins(admin_id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS squared_sessions_expiry_idx ON squared_sessions (expires_at);
