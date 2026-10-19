import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MwApiParams } from 'wiki-saikou';
import { readPage, writePage, type PageWriteApi } from './pageWrite.js';

/** 造一个按标题回话的 stub；online 里没有的当不存在 */
function makeApi(editResponse: unknown, online: Record<string, { revid: number; content: string }>) {
	const seen = { queried: [] as string[], edited: [] as MwApiParams[] };
	const api: PageWriteApi = {
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
			seen.edited.push(params);
			return { data: editResponse as T };
		},
	};
	return { api, seen };
}

test('读页面带回正文与版本号；页面不存在时两者都是 null', async () => {
	const { api } = makeApi({}, { 页A: { revid: 7, content: '旧内容' } });
	assert.deepEqual(await readPage(api, '页A'), { content: '旧内容', revid: 7 });
	assert.deepEqual(await readPage(api, '页B'), { content: null, revid: null });
});

test('基线与线上一致时按基线写入，成功返回新版本号', async () => {
	const { api, seen } = makeApi({ edit: { result: 'Success', newrevid: 100 } }, { 页A: { revid: 7, content: '旧' } });
	const result = await writePage(api, { title: '页A', text: '新', baseRevid: 7, summary: '改' });
	assert.deepEqual(result, { ok: true, revid: 100 });
	assert.equal(seen.edited[0].baserevid, 7);
	assert.equal(seen.edited[0].text, '新');
});

test('线上不存在时用 createonly，基线为 null', async () => {
	const { api, seen } = makeApi({ edit: { result: 'Success', newrevid: 100 } }, {});
	const result = await writePage(api, { title: '页A', text: '新', baseRevid: null, summary: '改' });
	assert.deepEqual(result, { ok: true, revid: 100 });
	assert.equal(seen.edited[0].createonly, 1);
	assert.equal(seen.edited[0].baserevid, undefined);
});

test('基线不一致返回冲突并带回线上内容', async () => {
	const { api, seen } = makeApi({ edit: { result: 'Success', newrevid: 100 } }, { 页A: { revid: 9, content: '别人改过' } });
	const result = await writePage(api, { title: '页A', text: '新', baseRevid: 7, summary: '改' });
	assert.deepEqual(result, { ok: false, reason: 'conflict', remote: '别人改过', remoteRevid: 9 });
	assert.equal(seen.edited.length, 0);
});

test('线上不存在而基线非空时按缺失返回', async () => {
	const { api } = makeApi({}, {});
	const result = await writePage(api, { title: '页A', text: '新', baseRevid: 7, summary: '改' });
	assert.deepEqual(result, { ok: false, reason: 'missing', remote: null, remoteRevid: null });
});

test('force 跳过基线检查，并以线上当前版本为基线写入', async () => {
	const { api, seen } = makeApi({ edit: { result: 'Success', newrevid: 100 } }, { 页A: { revid: 9, content: '别人改过' } });
	const result = await writePage(api, { title: '页A', text: '新', baseRevid: 7, force: true, summary: '改' });
	assert.deepEqual(result, { ok: true, revid: 100 });
	assert.equal(seen.edited[0].baserevid, 9);
});

test('入队计为成功，返回的版本号为 null', async () => {
	const { api } = makeApi({ error: { code: 'moderation-edit-queued', info: '入队' } }, { 页A: { revid: 7, content: '旧' } });
	assert.deepEqual(await writePage(api, { title: '页A', text: '新', baseRevid: 7, summary: '改' }), { ok: true, revid: null });
});

test('createonly 撞上已存在按冲突返回', async () => {
	const { api } = makeApi({ error: { code: 'articleexists', info: '已存在' } }, {});
	assert.deepEqual(await writePage(api, { title: '页A', text: '新', baseRevid: null, summary: '改' }), { ok: false, reason: 'conflict', remote: null, remoteRevid: null });
});

test('其他接口错误抛错，不伪装成功', async () => {
	const { api } = makeApi({ error: { code: 'protectedpage', info: '受保护' } }, { 页A: { revid: 7, content: '旧' } });
	await assert.rejects(() => writePage(api, { title: '页A', text: '新', baseRevid: 7, summary: '改' }), /protectedpage/);
});
