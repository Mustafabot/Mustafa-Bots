import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from './history.js';
import type { TaskRecord } from './taskRunner.js';

function makeRecord(): TaskRecord {
	return {
		id: 'task-1',
		descriptorId: 'text-replace',
		label: '全站文本替换',
		argv: [],
		status: 'succeeded',
		startedAt: 1700000000000,
		endedAt: 1700000060000,
		summary: { changed: 2, staleSkipped: 1, failed: 0 },
		events: [
			{ type: 'edit', title: '页面甲', status: 'changed', oldRevid: 100, newRevid: 101, message: '替换 ×1', at: 1 },
			{ type: 'edit', title: '页面乙', status: 'skipped', oldRevid: 200, newRevid: null, message: '已无匹配', at: 2 },
			{ type: 'log', level: 'info', message: '无关日志', at: 3 },
		],
	};
}

test('保存后能按 id 取回任务与涉及页面', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-history-'));
	const store = new HistoryStore(join(dir, 'history.db'));
	try {
		store.saveTask(makeRecord(), { '--wiki': 'zh' });
		const tasks = store.listTasks();
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].descriptorId, 'text-replace');
		assert.equal(tasks[0].summaryJson, JSON.stringify({ changed: 2, staleSkipped: 1, failed: 0 }));

		const detail = store.getTask('task-1');
		assert.ok(detail);
		assert.equal(detail.pages.length, 2);
		assert.deepEqual(
			detail.pages.map((p) => p.title),
			['页面甲', '页面乙'],
		);
		assert.equal(detail.pages[0].newRevid, 101);
		assert.equal(detail.pages[1].newRevid, null);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('重复保存同一任务只保留一条记录', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-history-'));
	const store = new HistoryStore(join(dir, 'history.db'));
	try {
		store.saveTask(makeRecord(), {});
		store.saveTask(makeRecord(), {});
		assert.equal(store.listTasks().length, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('取不存在的任务返回 null', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-history-'));
	const store = new HistoryStore(join(dir, 'history.db'));
	try {
		assert.equal(store.getTask('没有这个'), null);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
