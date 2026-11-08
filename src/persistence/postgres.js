import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const schemaUrl = new URL('./schema.sql', import.meta.url);

export class PostgresStore {
	constructor(config) {
		this.pool = new Pool({
			connectionString: config.databaseUrl,
			ssl: config.databaseSsl ? {} : undefined,
			max: 4,
			idleTimeoutMillis: 10_000,
			connectionTimeoutMillis: 10_000,
		});
	}

	async connect() {
		await this.pool.query('SELECT 1');
		await this.pool.query(await readFile(fileURLToPath(schemaUrl), 'utf8'));
		await this.pool.query(
			`UPDATE squared_executions
			 SET status = 'abandoned', error = 'Process restarted before execution finished', finished_at = now()
			 WHERE status IN ('queued', 'running')`,
		);
	}

	async close() {
		await this.pool.end();
	}

	async listWorkflows() {
		const { rows } = await this.pool.query(
			' SELECT id, name, active, definition, created_at, updated_at FROM squared_workflows ORDER BY updated_at DESC',
		);
		return rows.map(workflowRow);
	}

	async getWorkflow(id) {
		const { rows } = await this.pool.query(
			' SELECT id, name, active, definition, created_at, updated_at FROM squared_workflows WHERE id = $1',
			[id],
		);
		return rows[0] ? workflowRow(rows[0]) : null;
	}

	async saveWorkflow(workflow) {
		const { rows } = await this.pool.query(
			`INSERT INTO squared_workflows (id, name, active, definition)
			 VALUES ($1, $2, $3, $4::jsonb)
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active,
			 definition = EXCLUDED.definition, updated_at = now()
			 RETURNING id, name, active, definition, created_at, updated_at`,
			[workflow.id, workflow.name, workflow.active, JSON.stringify(workflow)],
		);
		return workflowRow(rows[0]);
	}

	async deleteWorkflow(id) {
		const result = await this.pool.query('DELETE FROM squared_workflows WHERE id = $1', [id]);
		return result.rowCount > 0;
	}

	async listScheduleWorkflows() {
		const { rows } = await this.pool.query(
			`SELECT w.id, w.name, w.active, w.definition, w.created_at, w.updated_at,
			 (SELECT max(e.created_at) FROM squared_executions e
			  WHERE e.workflow_id = w.id AND e.trigger_type = 'schedule') AS last_scheduled_at
			 FROM squared_workflows w WHERE w.active = true ORDER BY w.updated_at`,
		);
		return rows.map((row) => ({ ...workflowRow(row), lastScheduledAt: row.last_scheduled_at }));
	}

	async createExecution(execution) {
		await this.pool.query(
			`INSERT INTO squared_executions (id, workflow_id, trigger_type, status, input)
			 VALUES ($1, $2, $3, 'queued', $4::jsonb)`,
			[execution.id, execution.workflowId, execution.triggerType, JSON.stringify(execution.input ?? {})],
		);
	}

	async startExecution(id) {
		await this.pool.query(
			`UPDATE squared_executions SET status = 'running', started_at = now() WHERE id = $1`,
			[id],
		);
	}

	async finishExecution(id, output) {
		await this.pool.query(
			`UPDATE squared_executions SET status = 'succeeded', output = $2::jsonb,
			 finished_at = now() WHERE id = $1`,
			[id, JSON.stringify(output ?? null)],
		);
	}

	async failExecution(id, error) {
		await this.pool.query(
			`UPDATE squared_executions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
			[id, String(error).slice(0, 4_000)],
		);
	}

	async getExecution(id) {
		const { rows } = await this.pool.query('SELECT * FROM squared_executions WHERE id = $1', [id]);
		return rows[0] ? executionRow(rows[0]) : null;
	}

	async listExecutions(limit = 50) {
		const { rows } = await this.pool.query(
			'SELECT * FROM squared_executions ORDER BY created_at DESC LIMIT $1',
			[limit],
		);
		return rows.map(executionRow);
	}

	async createCredential({ id, name, encryptedValue }) {
		await this.pool.query(
			'INSERT INTO squared_credentials (id, name, encrypted_value) VALUES ($1, $2, $3)',
			[id, name, encryptedValue],
		);
	}

	async listCredentials() {
		const { rows } = await this.pool.query(
			'SELECT id, name, created_at, updated_at FROM squared_credentials ORDER BY name',
		);
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	async getCredential(id) {
		const { rows } = await this.pool.query(
			'SELECT id, name, encrypted_value FROM squared_credentials WHERE id = $1',
			[id],
		);
		return rows[0] ? { id: rows[0].id, name: rows[0].name, encryptedValue: rows[0].encrypted_value } : null;
	}

	async deleteCredential(id) {
		const result = await this.pool.query('DELETE FROM squared_credentials WHERE id = $1', [id]);
		return result.rowCount > 0;
	}
}

function workflowRow(row) {
	return {
		...row.definition,
		id: row.id,
		name: row.name,
		active: row.active,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function executionRow(row) {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		triggerType: row.trigger_type,
		status: row.status,
		input: row.input,
		output: row.output,
		error: row.error,
		createdAt: row.created_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
}
