import { DatabaseSync } from 'node:sqlite';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDataDirectory } from './data-directory.js';

const schemaUrl = new URL('./schema.sqlite.sql', import.meta.url);

export class SqliteStore {
	constructor(dataDir) {
		this.dataDir = dataDir;
		this.databasePath = join(dataDir, 'squared.sqlite');
	}

	async connect() {
		await ensurePrivateDataDirectory(this.dataDir);
		this.db = new DatabaseSync(this.databasePath);
		if (process.platform !== 'win32') await chmod(this.databasePath, 0o600);
		this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
		this.db.exec(await readFile(schemaUrl, 'utf8'));
		this.db.prepare("UPDATE squared_executions SET status = 'abandoned', error = ?, finished_at = CURRENT_TIMESTAMP WHERE status IN ('queued', 'running')")
			.run('Process restarted before execution finished');
		await this.deleteExpiredSessions(Date.now());
	}

	async close() {
		this.db?.close();
	}

	async listWorkflows() {
		return this.db.prepare('SELECT id, name, active, definition, created_at, updated_at FROM squared_workflows ORDER BY updated_at DESC')
			.all().map(workflowRow);
	}

	async getWorkflow(id) {
		const row = this.db.prepare('SELECT id, name, active, definition, created_at, updated_at FROM squared_workflows WHERE id = ?').get(id);
		return row ? workflowRow(row) : null;
	}

	async saveWorkflow(workflow) {
		this.db.prepare(`INSERT INTO squared_workflows (id, name, active, definition)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, active = excluded.active,
			definition = excluded.definition, updated_at = CURRENT_TIMESTAMP`)
			.run(workflow.id, workflow.name, workflow.active ? 1 : 0, JSON.stringify(workflow));
		return this.getWorkflow(workflow.id);
	}

	async deleteWorkflow(id) {
		return this.db.prepare('DELETE FROM squared_workflows WHERE id = ?').run(id).changes > 0;
	}

	async listScheduleWorkflows() {
		return this.db.prepare(`SELECT w.id, w.name, w.active, w.definition, w.created_at, w.updated_at,
			(SELECT max(e.created_at) FROM squared_executions e WHERE e.workflow_id = w.id AND e.trigger_type = 'schedule') AS last_scheduled_at
			FROM squared_workflows w WHERE w.active = 1 ORDER BY w.updated_at`).all()
			.map((row) => ({ ...workflowRow(row), lastScheduledAt: row.last_scheduled_at }));
	}

	async createExecution(execution) {
		this.db.prepare(`INSERT INTO squared_executions (id, workflow_id, trigger_type, status, input)
			VALUES (?, ?, ?, 'queued', ?)`).run(execution.id, execution.workflowId, execution.triggerType, JSON.stringify(execution.input ?? {}));
	}

	async startExecution(id) {
		this.db.prepare("UPDATE squared_executions SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
	}

	async finishExecution(id, output) {
		this.db.prepare("UPDATE squared_executions SET status = 'succeeded', output = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(output === undefined ? null : JSON.stringify(output), id);
	}

	async failExecution(id, error) {
		this.db.prepare("UPDATE squared_executions SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(String(error).slice(0, 4_000), id);
	}

	async getExecution(id) {
		const row = this.db.prepare('SELECT * FROM squared_executions WHERE id = ?').get(id);
		return row ? executionRow(row) : null;
	}

	async deleteExecution(id) {
		return this.db.prepare('DELETE FROM squared_executions WHERE id = ?').run(id).changes > 0;
	}

	async listExecutions(limit = 50) {
		return this.db.prepare('SELECT * FROM squared_executions ORDER BY created_at DESC LIMIT ?').all(limit).map(executionRow);
	}

	async createCredential({ id, name, encryptedValue }) {
		this.db.prepare('INSERT INTO squared_credentials (id, name, encrypted_value) VALUES (?, ?, ?)').run(id, name, encryptedValue);
	}

	async listCredentials() {
		return this.db.prepare('SELECT id, name, created_at, updated_at FROM squared_credentials ORDER BY name').all().map((row) => ({
			id: row.id,
			name: row.name,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	async getCredential(id) {
		const row = this.db.prepare('SELECT id, name, encrypted_value FROM squared_credentials WHERE id = ?').get(id);
		return row ? { id: row.id, name: row.name, encryptedValue: row.encrypted_value } : null;
	}

	async deleteCredential(id) {
		return this.db.prepare('DELETE FROM squared_credentials WHERE id = ?').run(id).changes > 0;
	}

	async getAdmin() {
		const row = this.db.prepare('SELECT admin_id, email, password_hash, created_at FROM squared_admins WHERE admin_id = \'owner\'').get();
		return row ? { id: row.admin_id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at } : null;
	}

	async createAdmin({ email, passwordHash }) {
		const result = this.db.prepare("INSERT INTO squared_admins (admin_id, email, password_hash) VALUES ('owner', ?, ?) ON CONFLICT (admin_id) DO NOTHING")
			.run(email, passwordHash);
		return result.changes === 1;
	}

	async createSession({ tokenHash, expiresAt }) {
		this.db.prepare('INSERT INTO squared_sessions (token_hash, admin_id, expires_at) VALUES (?, \'owner\', ?)').run(tokenHash, expiresAt);
	}

	async getSession(tokenHash, now = Date.now()) {
		const row = this.db.prepare(`SELECT s.token_hash, s.expires_at, a.admin_id, a.email
			FROM squared_sessions s JOIN squared_admins a ON a.admin_id = s.admin_id
			WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, now);
		return row ? { tokenHash: row.token_hash, expiresAt: row.expires_at, adminId: row.admin_id, email: row.email } : null;
	}

	async deleteSession(tokenHash) {
		return this.db.prepare('DELETE FROM squared_sessions WHERE token_hash = ?').run(tokenHash).changes > 0;
	}

	async deleteExpiredSessions(now = Date.now()) {
		this.db.prepare('DELETE FROM squared_sessions WHERE expires_at <= ?').run(now);
	}
}

function workflowRow(row) {
	const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
	return { ...definition, id: row.id, name: row.name, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at };
}

function executionRow(row) {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		triggerType: row.trigger_type,
		status: row.status,
		input: parseJson(row.input),
		output: parseJson(row.output),
		error: row.error,
		createdAt: row.created_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
}

function parseJson(value) {
	return value === null || value === undefined ? null : typeof value === 'string' ? JSON.parse(value) : value;
}
