import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_HEADER, QUEUE_PAGE, parseQueue, renderQueue } from './queueFormat.js';

const withPoem = (inner: string): string => `${QUEUE_HEADER}<poem>\n${inner}\n</poem>`;

test('队列页标题是那个配置页', () => {
	assert.equal(QUEUE_PAGE, 'User:没有羽翼的格雷塔/BotConfig/FileRestore');
});

test('解析 <poem> 内的非空行，去首尾空白并去重', () => {
	const content = withPoem('File:A.png\n  File:B.jpg  \n\nFile:A.png\nFile:C.gif');
	assert.deepEqual(parseQueue(content), ['File:A.png', 'File:B.jpg', 'File:C.gif']);
});

test('多个 poem 标签合并', () => {
	const content = `${QUEUE_HEADER}<poem>\nFile:A.png\n</poem>\n<poem>\nFile:B.png\n</poem>`;
	assert.deepEqual(parseQueue(content), ['File:A.png', 'File:B.png']);
});

test('没有 poem 标签时抛错，信息指明页面', () => {
	assert.throws(() => parseQueue('{{用户 允许他人编辑}}\n没有标签'), /poem/);
});

test('空的 poem 解析为空数组', () => {
	assert.deepEqual(parseQueue(`${QUEUE_HEADER}<poem>\n</poem>`), []);
});

test('生成时保留说明文字与 poem 块，条目逐行', () => {
	assert.equal(renderQueue(['File:A.png', 'File:B.png']), withPoem('File:A.png\nFile:B.png'));
});

test('生成空队列得到空 poem 块', () => {
	assert.equal(renderQueue([]), `${QUEUE_HEADER}<poem>\n</poem>`);
});

test('解析与生成往返一致', () => {
	const entries = ['File:A.png', 'File:B.png'];
	assert.deepEqual(parseQueue(renderQueue(entries)), entries);
});
