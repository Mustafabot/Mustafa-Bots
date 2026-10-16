import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageTextService, type PageTextApiFactory } from './pageText.js';

// 桩的键是修订号；省略 rvstartid（空串）表示"取最新"，桩里约定用 'latest' 这个键
const stub = (contents: Record<string, string | null>): PageTextApiFactory =>
	(async () => ({
		post: async (params: Record<string, unknown>) => {
			const raw = String(params.rvstartid ?? '');
			const text = contents[raw === '' ? 'latest' : raw] ?? null;
			return {
				data: {
					query: {
						pages: text === null ? [{ title: params.titles, missing: true }] : [{ title: params.titles, revisions: [{ revid: Number(raw), slots: { main: { content: text } } }] }],
					},
				},
			};
		},
	})) as PageTextApiFactory;

test('改前改后不同则给出三色行', async () => {
	const service = new PageTextService(stub({ '1': '甲\n乙', '2': '甲\n丙' }));
	const result = await service.diffByRevid('zh', '页面', 1, 2);
	assert.equal(result.ok, true);
	assert.ok(result.ok && result.lines.length === 3);
	assert.deepEqual(result.ok && result.lines.map((line) => line.op), ['equal', 'del', 'add']);
});

test('两个修订内容相同记为 unchanged 而不是错误', async () => {
	const service = new PageTextService(stub({ '1': '甲', '2': '甲' }));
	const result = await service.diffByRevid('zh', '页面', 1, 2);
	assert.equal(result.ok, false);
	assert.equal(!result.ok && result.reason, 'unchanged');
});

test('页面不存在记为 missing', async () => {
	const service = new PageTextService(stub({}));
	const result = await service.diffByRevid('zh', '页面', 1, 2);
	assert.equal(!result.ok && result.reason, 'missing');
});

test('按规则算改后文本，无匹配记为 unchanged', async () => {
	const service = new PageTextService(stub({ latest: '甲\n乙' }));
	const hit = await service.diffByRules('zh', '页面', [{ from: '乙', to: '丙' }]);
	assert.equal(hit.ok, true);
	assert.ok(hit.ok && hit.lines.some((line) => line.op === 'add' && line.text === '丙'));
	const miss = await service.diffByRules('zh', '页面', [{ from: '不存在', to: 'x' }]);
	assert.equal(!miss.ok && miss.reason, 'unchanged');
});

test('登录失败降级为 error 结果而不是抛出', async () => {
	const failing: PageTextApiFactory = async () => {
		throw new Error('登录失败');
	};
	const service = new PageTextService(failing);
	const byRevid = await service.diffByRevid('zh', '页面', 1, 2);
	assert.equal(byRevid.ok, false);
	assert.equal(!byRevid.ok && byRevid.reason, 'error');
	const byRules = await service.diffByRules('zh', '页面', [{ from: '甲', to: '乙' }]);
	assert.equal(byRules.ok, false);
	assert.equal(!byRules.ok && byRules.reason, 'error');
});
