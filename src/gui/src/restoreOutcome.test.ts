import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreOutcomesFromEvents } from './restoreOutcome';
import type { ProgressEvent } from './types';

const detail = (title: string, fields: Record<string, string | number | null>): ProgressEvent => ({ type: 'detail', title, fields, at: 0 });
const edit = (title: string, status: 'changed' | 'skipped' | 'failed', message?: string): ProgressEvent => ({ type: 'edit', title, status, oldRevid: null, newRevid: null, message, at: 0 });

test('detail 事件给出删除日志，键去掉 File: 前缀', () => {
	const outcomes = restoreOutcomesFromEvents([
		detail('File:a.png', { 最后编辑者: '甲', 最后编辑摘要: '侵权', 最后编辑时间: '2026-10-15', 版本数: 2, 可否还原: '可还原' }),
	]);
	const state = outcomes.get('a.png');
	assert.deepEqual(state?.log, { 最后编辑者: '甲', 最后编辑摘要: '侵权', 最后编辑时间: '2026-10-15', 版本数: 2, 可否还原: '可还原' });
	assert.equal(state?.restorable, true);
});

test('edit 事件给出本条结果：成功、跳过、失败各有说法', () => {
	const outcomes = restoreOutcomesFromEvents([
		edit('File:a.png', 'changed', '还原成功'),
		edit('File:b.png', 'skipped', '没有可还原的删除版本'),
		edit('File:c.png', 'failed', '还原失败：HTTP 500'),
	]);
	assert.equal(outcomes.get('a.png')?.result, '还原成功');
	assert.equal(outcomes.get('b.png')?.result, '没有可还原的删除版本');
	assert.equal(outcomes.get('c.png')?.result, '失败：还原失败：HTTP 500');
	// 只有"不在删除记录中 / 跳过"才算不可还原：这类失败/跳过行仍可再试
	assert.equal(outcomes.get('b.png')?.restorable, true);
	assert.equal(outcomes.get('c.png')?.restorable, true);
});

test('没有报告过的行不出现在结果里（界面上默认可还原）', () => {
	const outcomes = restoreOutcomesFromEvents([edit('File:b.png', 'changed', '还原成功')]);
	assert.equal(outcomes.get('a.png'), undefined);
});

test('detail 说「不在删除记录中」的行不可还原', () => {
	const outcomes = restoreOutcomesFromEvents([detail('File:a.png', { 可否还原: '不在删除记录中', 版本数: 0 })]);
	assert.equal(outcomes.get('a.png')?.restorable, false);
});

test('结果以「跳过」开头的行不可还原', () => {
	// 脚本对未给理由的跳过行只发跳过、不带消息，归并结果即字面量「跳过」
	const outcomes = restoreOutcomesFromEvents([edit('File:a.png', 'skipped')]);
	assert.equal(outcomes.get('a.png')?.result, '跳过');
	assert.equal(outcomes.get('a.png')?.restorable, false);
});

test('先报可还原、后报结果时两类信息并存', () => {
	const outcomes = restoreOutcomesFromEvents([
		detail('File:a.png', { 可否还原: '可还原', 版本数: 1 }),
		edit('File:a.png', 'changed', '还原成功'),
	]);
	assert.deepEqual(outcomes.get('a.png'), { log: { 可否还原: '可还原', 版本数: 1 }, result: '还原成功', restorable: true });
});
