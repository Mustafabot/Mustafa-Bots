import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MwApiParams } from 'wiki-saikou';
import { CategoryService, type CategoryApi } from './categories.js';

/** 造一个按前缀回话的 stub：只认给定时点里的那几个分类 */
function makeApi(available: string[]): { api: CategoryApi; queries: string[] } {
	const queries: string[] = [];
	return {
		queries,
		api: {
			async post<T>(params: MwApiParams): Promise<{ data: T }> {
				const prefix = String(params.acprefix ?? '');
				queries.push(prefix);
				const allcategories = available.filter((name) => name.startsWith(prefix)).map((name) => ({ '*': name }));
				return { data: { query: { allcategories } } as T };
			},
		},
	};
}

test('按前缀返回分类名', async () => {
	const { api, queries } = makeApi(['萌娘百科', '萌属性', '动画']);
	const service = new CategoryService(async () => api);
	assert.deepEqual(await service.search('萌'), ['萌娘百科', '萌属性']);
	assert.deepEqual(queries, ['萌']);
});

test('同一个前缀不重复查询', async () => {
	const { api, queries } = makeApi(['甲']);
	const service = new CategoryService(async () => api);
	await service.search('甲');
	await service.search('甲');
	assert.deepEqual(queries, ['甲']);
});

test('空前缀不查线上', async () => {
	const { api, queries } = makeApi(['甲']);
	const service = new CategoryService(async () => api);
	assert.deepEqual(await service.search('   '), []);
	assert.deepEqual(queries, []);
});
