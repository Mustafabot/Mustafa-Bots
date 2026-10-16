import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, summarizeDiff } from './pageDiff.js';

test('完全相同得到全 equal', () => {
	const lines = diffLines('a\nb\nc', 'a\nb\nc');
	assert.deepEqual(lines.map((line) => line.op), ['equal', 'equal', 'equal']);
	assert.deepEqual(summarizeDiff(lines), { added: 0, removed: 0, unchanged: 3 });
});

test('中间一行被改，记为一删一增', () => {
	const lines = diffLines('a\nb\nc', 'a\nB\nc');
	assert.deepEqual(lines, [
		{ op: 'equal', text: 'a' },
		{ op: 'del', text: 'b' },
		{ op: 'add', text: 'B' },
		{ op: 'equal', text: 'c' },
	]);
});

test('纯新增与纯删除', () => {
	assert.deepEqual(diffLines('', 'x\ny').map((line) => line.op), ['add', 'add']);
	assert.deepEqual(diffLines('x\ny', '').map((line) => line.op), ['del', 'del']);
});

test('行尾换行差异不算改动', () => {
	const lines = diffLines('a\nb', 'a\nb\n');
	assert.deepEqual(lines.map((line) => line.op), ['equal', 'equal']);
	assert.deepEqual(summarizeDiff(lines), { added: 0, removed: 0, unchanged: 2 });
});

test('行数超过上限时退化为整段替换，不卡死', () => {
	const oldText = Array.from({ length: 3000 }, (_, i) => `旧${i}`).join('\n');
	const newText = Array.from({ length: 3000 }, (_, i) => `新${i}`).join('\n');
	const lines = diffLines(oldText, newText);
	assert.equal(lines.length, 6000);
	assert.deepEqual(summarizeDiff(lines), { added: 3000, removed: 3000, unchanged: 0 });
});

test('退化路径仍保留公共前后缀', () => {
	const head = Array.from({ length: 10 }, () => '头').join('\n');
	const tail = Array.from({ length: 10 }, () => '尾').join('\n');
	const oldText = `${head}\n${Array.from({ length: 3000 }, (_, i) => `旧${i}`).join('\n')}\n${tail}`;
	const newText = `${head}\n${Array.from({ length: 3000 }, (_, i) => `新${i}`).join('\n')}\n${tail}`;
	const stats = summarizeDiff(diffLines(oldText, newText));
	assert.equal(stats.unchanged, 20);
	assert.equal(stats.added, 3000);
	assert.equal(stats.removed, 3000);
});
