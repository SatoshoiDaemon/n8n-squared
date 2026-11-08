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

CREATE TABLE IF NOT EXISTS squared_credentials (
	 id text PRIMARY KEY,
	 name text NOT NULL,
	 encrypted_value text NOT NULL,
	 created_at timestamptz NOT NULL DEFAULT now(),
	 updated_at timestamptz NOT NULL DEFAULT now()
);
