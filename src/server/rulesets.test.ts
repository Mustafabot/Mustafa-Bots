import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RulesetStore, RulesetPublisher, pageTitleFor, safeName, type RulesetApi } from './rulesets.js';

test('规则集名拼成配置页标题', () => {
	assert.equal(pageTitleFor('文本替换测试'), 'User:没有羽翼的格雷塔/BotConfig/文本替换测试');
});

test('名字里的路径分隔符被拒绝', () => {
	assert.throws(() => safeName('../逃逸'), /非法/);
	assert.throws(() => safeName('a/b'), /非法/);
	assert.throws(() => safeName('a\\b'), /非法/);
	assert.throws(() => safeName(''), /非法/);
	// Windows 驱动器相对路径：不挡的话 C:evil 会 resolve 到进程工作目录
	assert.throws(() => safeName('C:evil'), /非法/);
	assert.equal(safeName('文本替换 测试-1'), '文本替换 测试-1');
});

test('草稿可写可读可列可删', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-rulesets-'));
	const store = new RulesetStore(dir);
	try {
		assert.deepEqual(store.list(), []);
		store.write('甲', '{"rules":[]}', 42);
		const draft = store.read('甲');
		assert.ok(draft);
		assert.equal(draft.content, '{"rules":[]}');
		assert.equal(draft.baseRevid, 42);

		const listed = store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, '甲');
		assert.equal(listed[0].pageTitle, 'User:没有羽翼的格雷塔/BotConfig/甲');

		assert.equal(store.remove('甲'), true);
		assert.equal(store.read('甲'), null);
		assert.equal(store.remove('甲'), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('写入非法名字时抛错且不落盘', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-rulesets-'));
	const store = new RulesetStore(dir);
	try {
		assert.throws(() => store.write('../坏', '{}', null), /非法/);
		assert.deepEqual(store.list(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** 建一个临时草稿目录，返回 store 与清理函数 */
function tempStore(): { store: RulesetStore; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'gui-rulesets-'));
	return { store: new RulesetStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 造一个 stub api：query 固定返回 revid=7 的线上页面，
 * edit 返回给定的响应体。用于在无网络下覆盖 publish 的各条判定路径。
 */
function makeApi(editResponse: unknown): RulesetApi {
	return {
		async post<T>(): Promise<{ data: T }> {
			const online = { query: { pages: [{ revisions: [{ revid: 7, slots: { main: { content: '线上旧内容' } } }] }] } };
			return { data: online as T };
		},
		async postWithEditToken<T>(): Promise<{ data: T }> {
			return { data: editResponse as T };
		},
	};
}

test('发布时响应体里的 API 错误必须抛错，而不是假成功', async () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('丙', '{"rules":[]}', 7);
		const publisher = new RulesetPublisher(store, async () => makeApi({ error: { code: 'protectedpage', info: '页面被保护' } }));
		await assert.rejects(() => publisher.publish('丙'), /protectedpage/);
	} finally {
		cleanup();
	}
});

test('createonly 竞态下 articleexists 返回冲突而非成功', async () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('丁', '{"rules":[]}', 7);
		const publisher = new RulesetPublisher(store, async () => makeApi({ error: { code: 'articleexists', info: '页面已存在' } }));
		const result = await publisher.publish('丁');
		assert.deepEqual(result, { ok: false, reason: 'conflict', remote: null, remoteRevid: null });
	} finally {
		cleanup();
	}
});

test('审核入队的发布计为成功', async () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('戊', '{"rules":[]}', 7);
		const publisher = new RulesetPublisher(store, async () => makeApi({ error: { code: 'moderation-edit-queued', info: '已进入审核队列' } }));
		const result = await publisher.publish('戊');
		assert.deepEqual(result, { ok: true, revid: null });
	} finally {
		cleanup();
	}
});

test('成功发布返回新 revid 并更新草稿基线', async () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('己', '{"rules":[]}', 7);
		const publisher = new RulesetPublisher(store, async () => makeApi({ edit: { result: 'Success', newrevid: 100 } }));
		const result = await publisher.publish('己');
		assert.deepEqual(result, { ok: true, revid: 100 });
		assert.equal(store.read('己')?.baseRevid, 100);
	} finally {
		cleanup();
	}
});
