import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToLine, formatDuration } from './progressText';

test('用时格式化到合适的单位', () => {
	assert.equal(formatDuration(0), '0 秒');
	assert.equal(formatDuration(1200), '1 秒');
	assert.equal(formatDuration(72_000), '1 分 12 秒');
	assert.equal(formatDuration(3_725_000), '1 小时 2 分');
});

test('事件转成日志行，edit 事件带状态与说明', () => {
	const line = eventToLine({ type: 'edit', title: '苹果', status: 'changed', oldRevid: 1, newRevid: 2, message: '替换 ×3', at: 1700000000000 });
	assert.ok(line.includes('苹果'));
	assert.ok(line.includes('替换 ×3'));
});

test('edit 事件没有 message 时只显示页面名与状态', () => {
	const line = eventToLine({ type: 'edit', title: '苹果', status: 'skipped', oldRevid: null, newRevid: null, at: 1700000000000 });
	assert.ok(line.includes('苹果'));
	assert.ok(line.includes('跳过'));
});

test('progress 事件带上进度数字', () => {
	const line = eventToLine({ type: 'progress', done: 3, total: 10, message: '处理中', at: 1700000000000 });
	assert.ok(line.includes('处理中'));
	assert.ok(line.includes('3/10'));
});

test('progress 事件缺 total 时只显示已完成数', () => {
	const line = eventToLine({ type: 'progress', done: 5, at: 1700000000000 });
	assert.ok(line.includes('5'));
});

test('phase 事件渲染成阶段分隔行', () => {
	const line = eventToLine({ type: 'phase', name: '搜索', at: 1700000000000 });
	assert.ok(line.includes('搜索'));
});

test('log 事件原样输出 message', () => {
	const line = eventToLine({ type: 'log', level: 'warn', message: '镜像同步完成：写入 12 页', at: 1700000000000 });
	assert.equal(line, '镜像同步完成：写入 12 页');
});

test('done 事件把摘要各键转成中文标签', () => {
	const line = eventToLine({ type: 'done', summary: { changed: 3, skipped: 1 }, at: 1700000000000 });
	assert.ok(line.includes('修改 3'));
	assert.ok(line.includes('跳过 1'));
});
