import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MwApiParams } from 'wiki-saikou';
import { fetchCategoryMembers } from './categoryMembers.js';

type Params = Record<string, unknown>;

test('分页取全分类页面成员并去重', async () => {
	const calls: Params[] = [];
	const api = {
		post: async <T,>(params: MwApiParams): Promise<{ data: T }> => {
			calls.push(params as Params);
			const data =
				(params as Params).cmcontinue === undefined
					? { query: { categorymembers: [{ title: '甲' }, { title: '乙' }] }, continue: { cmcontinue: '下一页' } }
					: { query: { categorymembers: [{ title: '乙' }, { title: '丙' }, {}] } };
			return { data: data as T };
		},
	};

	assert.deepEqual(await fetchCategoryMembers(api, 'Category:测试'), ['甲', '乙', '丙']);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].action, 'query');
	assert.equal(calls[0].list, 'categorymembers');
	assert.equal(calls[0].cmtitle, 'Category:测试');
	assert.equal(calls[0].cmtype, 'page');
	assert.equal(calls[0].cmlimit, 'max');
	assert.equal(calls[1].cmcontinue, '下一页');
});

test('空分类返回空数组', async () => {
	const api = { post: async <T,>(): Promise<{ data: T }> => ({ data: { query: { categorymembers: [] } } as T }) };
	assert.deepEqual(await fetchCategoryMembers(api, 'Category:空'), []);
});
