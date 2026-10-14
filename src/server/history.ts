import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskRecord } from './taskRunner.js';

export interface TaskSummaryRow {
	id: string;
	descriptorId: string;
	label: string;
	paramsJson: string;
	startedAt: number;
	endedAt: number | null;
	status: string;
	summaryJson: string | null;
}

export interface TaskPageRow {
	taskId: string;
	title: string;
	action: string;
	oldRevid: number | null;
	newRevid: number | null;
	message: string | null;
}

/**
 * 任务历史的持久化。
 * 只存元数据与页面标题、新旧 revid——diff 正文不落库，需要时按 revid 向站点现拉。
 */
export class HistoryStore {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				descriptor_id TEXT NOT NULL,
				label TEXT NOT NULL,
				params_json TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				status TEXT NOT NULL,
				summary_json TEXT
			);
			CREATE TABLE IF NOT EXISTS task_pages (
				task_id TEXT NOT NULL,
				title TEXT NOT NULL,
				action TEXT NOT NULL,
				old_revid INTEGER,
				new_revid INTEGER,
				message TEXT,
				PRIMARY KEY (task_id, title)
			);
		`);
	}

	saveTask(record: TaskRecord, params: Record<string, unknown>): void {
		this.db
			.prepare(
				`INSERT INTO tasks (id, descriptor_id, label, params_json, started_at, ended_at, status, summary_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					ended_at = excluded.ended_at,
					status = excluded.status,
					summary_json = excluded.summary_json`,
			)
			.run(
				record.id,
				record.descriptorId,
				record.label,
				JSON.stringify(params),
				record.startedAt,
				record.endedAt,
				record.status,
				record.summary ? JSON.stringify(record.summary) : null,
			);
		this.db.prepare('DELETE FROM task_pages WHERE task_id = ?').run(record.id);
		const insertPage = this.db.prepare(
			'INSERT OR REPLACE INTO task_pages (task_id, title, action, old_revid, new_revid, message) VALUES (?, ?, ?, ?, ?, ?)',
		);
		for (const event of record.events) {
			if (event.type !== 'edit') continue;
			insertPage.run(record.id, event.title, event.status, event.oldRevid, event.newRevid, event.message ?? null);
		}
	}

	listTasks(limit = 100): TaskSummaryRow[] {
		return this.db
			.prepare(
				`SELECT id, descriptor_id AS descriptorId, label, params_json AS paramsJson,
				        started_at AS startedAt, ended_at AS endedAt, status, summary_json AS summaryJson
				 FROM tasks ORDER BY started_at DESC LIMIT ?`,
			)
			.all(limit) as unknown as TaskSummaryRow[];
	}

	getTask(id: string): { task: TaskSummaryRow; pages: TaskPageRow[] } | null {
		const task = this.db
			.prepare(
				`SELECT id, descriptor_id AS descriptorId, label, params_json AS paramsJson,
				        started_at AS startedAt, ended_at AS endedAt, status, summary_json AS summaryJson
				 FROM tasks WHERE id = ?`,
			)
			.get(id) as unknown as TaskSummaryRow | undefined;
		if (!task) return null;
		const pages = this.db
			.prepare(
				`SELECT task_id AS taskId, title, action, old_revid AS oldRevid, new_revid AS newRevid, message
				 FROM task_pages WHERE task_id = ? ORDER BY rowid`,
			)
			.all(id) as unknown as TaskPageRow[];
		return { task, pages };
	}

	close(): void {
		this.db.close();
	}
}
