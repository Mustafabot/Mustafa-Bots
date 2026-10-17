import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MwApiParams } from 'wiki-saikou';
import { RulesetStore, RulesetPublisher, draftBaseline, pageTitleFor, resolveRunRuleset, safeName, type RulesetApi } from './rulesets.js';

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

test('任务可直接吃规则内容，不必先存草稿', () => {
	const { store, cleanup } = tempStore();
	try {
		const run = resolveRunRuleset(store, { rulesetContent: '{"rules":[]}' });
		assert.deepEqual(run, { name: '未命名规则', content: '{"rules":[]}' });
	} finally {
		cleanup();
	}
});

test('内容与名字一起给时按名字当标签，内容照用', () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('庚', '{"rules":[{"from":"旧"}]}', null);
		const run = resolveRunRuleset(store, { rulesetName: '庚', rulesetContent: '{"rules":[{"from":"新"}]}' });
		assert.deepEqual(run, { name: '庚', content: '{"rules":[{"from":"新"}]}' });
	} finally {
		cleanup();
	}
});

test('只给名字时读本地草稿', () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('辛', '{"rules":[]}', null);
		assert.deepEqual(resolveRunRuleset(store, { rulesetName: '辛' }), { name: '辛', content: '{"rules":[]}' });
	} finally {
		cleanup();
	}
});

test('仅同步镜像时允许没有规则，其余情况缺规则要拦下', () => {
	const { store, cleanup } = tempStore();
	try {
		assert.equal(resolveRunRuleset(store, { syncOnly: true }), null);
		assert.throws(() => resolveRunRuleset(store, {}), /规则/);
		assert.throws(() => resolveRunRuleset(store, { rulesetName: '查无此草稿' }), /没有本地草稿/);
		assert.throws(() => resolveRunRuleset(store, { rulesetContent: '   ' }), /规则/);
	} finally {
		cleanup();
	}
});

/**
 * 造一个 stub api：按 titles 查线上页面（映射里没有的当不存在），
 * 并记下查询与编辑用的页面标题，供断言"发到了哪一页"。
 */
function makePageApi(editResponse: unknown, online: Record<string, { revid: number; content: string }>) {
	const seen = { queried: [] as string[], edited: [] as string[] };
	const api: RulesetApi = {
		async post<T>(params: MwApiParams): Promise<{ data: T }> {
			const title = String(params.titles);
			seen.queried.push(title);
			const page = online[title];
			const data = page
				? { query: { pages: [{ revisions: [{ revid: page.revid, slots: { main: { content: page.content } } }] }] } }
				: { query: { pages: [{ missing: true }] } };
			return { data: data as T };
		},
		async postWithEditToken<T>(params: MwApiParams): Promise<{ data: T }> {
			seen.edited.push(String(params.title));
			return { data: editResponse as T };
		},
	};
	return { api, seen };
}

test('发布写到草稿记的配置页，而不是拼默认前缀', async () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('甲', '{"rules":[]}', 7, 'User:某某/我的替换规则');
		const { api, seen } = makePageApi({ edit: { result: 'Success', newrevid: 100 } }, {
			'User:某某/我的替换规则': { revid: 7, content: '线上旧内容' },
		});
		const publisher = new RulesetPublisher(store, async () => api);
		assert.deepEqual(await publisher.publish('甲'), { ok: true, revid: 100 });
		assert.deepEqual(seen, { queried: ['User:某某/我的替换规则'], edited: ['User:某某/我的替换规则'] });
		assert.equal(store.read('甲')?.page, 'User:某某/我的替换规则');
	} finally {
		cleanup();
	}
});

test('临时换目标页时不再沿用旧页的基线', async () => {
	const { store, cleanup } = tempStore();
	try {
		// 草稿记的页是 A、基线 7；发到已存在的页 B（revid 9）时不能拿 7 去冒充基线
		store.write('乙', '{"rules":[]}', 7, '页A');
		const { api, seen } = makePageApi({ edit: { result: 'Success', newrevid: 100 } }, {
			'页B': { revid: 9, content: '页B 的线上内容' },
		});
		const publisher = new RulesetPublisher(store, async () => api);
		assert.deepEqual(await publisher.publish('乙', { page: '页B' }), {
			ok: false,
			reason: 'conflict',
			remote: '页B 的线上内容',
			remoteRevid: 9,
		});
		assert.deepEqual(seen.edited, []);
		// 发布没成功，草稿记的页与基线都不该被改动
		assert.equal(store.read('乙')?.page, '页A');
		assert.equal(store.read('乙')?.baseRevid, 7);
	} finally {
		cleanup();
	}
});

test('发到还不存在的页时按首次创建处理', async () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('丙', '{"rules":[]}', 7, '页A');
		const { api, seen } = makePageApi({ edit: { result: 'Success', newrevid: 100 } }, {});
		const publisher = new RulesetPublisher(store, async () => api);
		assert.deepEqual(await publisher.publish('丙', { page: '页B' }), { ok: true, revid: 100 });
		assert.deepEqual(seen.edited, ['页B']);
		assert.equal(store.read('丙')?.page, '页B');
		assert.equal(store.read('丙')?.baseRevid, 100);
	} finally {
		cleanup();
	}
});

test('冲突后可指定以线上当前版本为基线覆盖', async () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('丁', '{"rules":[]}', 5);
		const { api } = makePageApi({ edit: { result: 'Success', newrevid: 100 } }, {
			'User:没有羽翼的格雷塔/BotConfig/丁': { revid: 9, content: '别人改过的内容' },
		});
		const publisher = new RulesetPublisher(store, async () => api);
		assert.deepEqual(await publisher.publish('丁', { force: true }), { ok: true, revid: 100 });
		assert.equal(store.read('丁')?.baseRevid, 100);
	} finally {
		cleanup();
	}
});

test('换页时旧基线作废，同页才沿用', () => {
	const previous = { page: '页A', baseRevid: 7 };
	assert.equal(draftBaseline(previous, '页B'), null);
	assert.equal(draftBaseline(previous, '页A'), 7);
	assert.equal(draftBaseline(previous, undefined), 7);
	assert.equal(draftBaseline(previous, '  '), 7);
	assert.equal(draftBaseline(null, '页B'), null);
});

test('草稿只存调用方给的基线与目标页，不替调用方猜', () => {
	const { store, cleanup } = tempStore();
	try {
		store.write('壬', '{"rules":[]}', 7, '页A');
		const draft = store.write('壬', '{"rules":[]}', 7, '页B');
		assert.equal(draft.page, '页B');
		assert.equal(draft.baseRevid, 7);
	} finally {
		cleanup();
	}
});
