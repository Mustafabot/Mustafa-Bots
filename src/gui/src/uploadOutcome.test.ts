import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomesFromEvents } from './uploadOutcome';
import type { ProgressEvent } from './types';

const detail = (title: string, status: string): ProgressEvent => ({ type: 'detail', title, fields: { 线上状态: status }, at: 0 });
const edit = (title: string, status: 'changed' | 'skipped' | 'failed', message?: string): ProgressEvent => ({ type: 'edit', title, status, oldRevid: null, newRevid: null, message, at: 0 });

test('detail 事件给出线上状态，键去掉 File: 前缀', () => {
	const outcomes = outcomesFromEvents([detail('File:自测图.png', '已存在')]);
	assert.equal(outcomes.get('自测图.png')?.online, '已存在');
});

test('edit 事件给出本条结果：成功、空跑、跳过、失败各有说法', () => {
	const outcomes = outcomesFromEvents([
		edit('File:a.png', 'changed', '上传成功'),
		edit('File:b.png', 'changed', '[DRY-RUN] 将上传'),
		edit('File:c.png', 'skipped', '线上已存在，差分上传跳过'),
		edit('File:d.png', 'failed', '上传失败：HTTP 500'),
	]);
	assert.equal(outcomes.get('a.png')?.result, '成功');
	assert.equal(outcomes.get('b.png')?.result, '空跑');
	assert.equal(outcomes.get('c.png')?.result, '线上已存在，差分上传跳过');
	assert.equal(outcomes.get('d.png')?.result, '失败：上传失败：HTTP 500');
});

test('同一文件先检查后上传时两条信息并存', () => {
	const outcomes = outcomesFromEvents([detail('File:a.png', '不存在'), edit('File:a.png', 'changed', '上传成功')]);
	assert.deepEqual(outcomes.get('a.png'), { online: '不存在', result: '成功' });
});
