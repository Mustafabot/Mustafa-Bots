import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChildArgs, createLineBuffer, feedLineBuffer, flushLineBuffer } from './taskRunner.js';
import { parseChildLine } from '../core/progress.js';

test('子进程参数用当前 node 加 tsx 加载器，避免依赖 npx 与 shell 引号', () => {
	const args = buildChildArgs('src/replace/TextReplace.ts', ['--wiki', 'zh', '--dry-run']);
	assert.equal(args[0], '--import');
	assert.equal(args[1], 'tsx');
	assert.equal(args[2], 'src/replace/TextReplace.ts');
	assert.deepEqual(args.slice(3), ['--wiki', 'zh', '--dry-run']);
});

test('一行事件被切成两个 chunk 后仍还原为一条完整事件', () => {
	const buffer = createLineBuffer();
	const line = '__MWBOT_EVENT__ {"type":"done","summary":{"changed":3},"at":1}\n';
	const half = Math.floor(line.length / 2);
	const first = feedLineBuffer(buffer, Buffer.from(line.slice(0, half), 'utf-8'));
	const second = feedLineBuffer(buffer, Buffer.from(line.slice(half), 'utf-8'));
	const lines = [...first, ...second];
	assert.equal(lines.length, 1, '被切开的行只能产出一次');
	const event = parseChildLine(lines[0]);
	assert.deepEqual(event, { type: 'done', summary: { changed: 3 }, at: 1 });
});

test('多字节汉字被切成两个 chunk 后不产生替换字符', () => {
	const buffer = createLineBuffer();
	const bytes = Buffer.from('标题甲\n', 'utf-8');
	// “标”占 3 字节，从第 1 字节后切开，正好落在字符中间
	const lines = [
		...feedLineBuffer(buffer, bytes.subarray(0, 1)),
		...feedLineBuffer(buffer, bytes.subarray(1)),
	];
	assert.deepEqual(lines, ['标题甲']);
	assert.ok(!lines.join('').includes('�'), '不应出现 UTF-8 替换字符');
});

test('最后一行没有换行结尾时由 flush 冲出，且重复 flush 不再吐行', () => {
	const buffer = createLineBuffer();
	assert.deepEqual(feedLineBuffer(buffer, Buffer.from('无换行日志', 'utf-8')), []);
	assert.deepEqual(flushLineBuffer(buffer), ['无换行日志']);
	assert.deepEqual(flushLineBuffer(buffer), [], 'flush 后缓冲应为空');
});

test('一个 chunk 内的多行逐行产出，末尾半行留待下一 chunk', () => {
	const buffer = createLineBuffer();
	assert.deepEqual(feedLineBuffer(buffer, Buffer.from('一\n二\n三', 'utf-8')), ['一', '二']);
	assert.deepEqual(feedLineBuffer(buffer, Buffer.from('四\n', 'utf-8')), ['三四']);
});
