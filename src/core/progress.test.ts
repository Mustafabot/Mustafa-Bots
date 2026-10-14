import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_PREFIX, createEmitter, parseChildLine } from './progress.js';

test('事件行能被还原为事件对象', () => {
	const event = { type: 'done' as const, summary: { changed: 3 }, at: 1700000000000 };
	const parsed = parseChildLine(`${EVENT_PREFIX}${JSON.stringify(event)}`);
	assert.deepEqual(parsed, event);
});

test('普通日志行被包装为 log 事件', () => {
	const parsed = parseChildLine('镜像同步完成：写入 12 页');
	assert.equal(parsed.type, 'log');
	assert.equal(parsed.type === 'log' && parsed.message, '镜像同步完成：写入 12 页');
});

test('末尾的 CR 被去除', () => {
	const parsed = parseChildLine('普通日志\r\n');
	assert.equal(parsed.type === 'log' && parsed.message, '普通日志');
});

test('前缀正确但 JSON 损坏时降级为 warn 日志', () => {
	const parsed = parseChildLine(`${EVENT_PREFIX}{坏掉的 json`);
	assert.equal(parsed.type, 'log');
	assert.equal(parsed.type === 'log' && parsed.level, 'warn');
});

test('关闭时发射器不写任何输出', () => {
	const written: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		written.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		createEmitter(false)({ type: 'phase', name: '搜索' });
	} finally {
		process.stdout.write = original;
	}
	assert.equal(written.length, 0);
});
