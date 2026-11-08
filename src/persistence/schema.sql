CREATE TABLE IF NOT EXISTS squared_workflows (
	 id text PRIMARY KEY,
	 name text NOT NULL,
	 active boolean NOT NULL DEFAULT false,
	 definition jsonb NOT NULL,
	 created_at timestamptz NOT NULL DEFAULT now(),
	 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squared_executions (
	 id text PRIMARY KEY,
	 workflow_id text NOT NULL,
	 trigger_type text NOT NULL,
	 status text NOT NULL,
	 input jsonb NOT NULL DEFAULT '{}'::jsonb,
	 output jsonb,
	 error text,
	 created_at timestamptz NOT NULL DEFAULT now(),
	 started_at timestamptz,
	 finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS squared_executions_workflow_created_idx
	ON squared_executions (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS squared_workflow_runtime_state (
	workflow_id text PRIMARY KEY,
	state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squared_execution_waits (
	execution_id text PRIMARY KEY REFERENCES squared_executions(id) ON DELETE CASCADE,
	node_name text NOT NULL,
	resume_at timestamptz,
	accepts_resume_request boolean NOT NULL DEFAULT true,
	input_json jsonb NOT NULL DEFAULT '[]'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS squared_execution_waits_resume_idx ON squared_execution_waits (resume_at);

CREATE TABLE IF NOT EXISTS squared_credentials (
	 id text PRIMARY KEY,
	 name text NOT NULL,
	 encrypted_value text NOT NULL,
	 created_at timestamptz NOT NULL DEFAULT now(),
	 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squared_admins (
	admin_id text PRIMARY KEY CHECK (admin_id = 'owner'),
	email text NOT NULL UNIQUE,
	password_hash text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS squared_sessions (
	token_hash text PRIMARY KEY,
	admin_id text NOT NULL REFERENCES squared_admins(admin_id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS squared_sessions_expiry_idx ON squared_sessions (expires_at);
