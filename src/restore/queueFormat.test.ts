import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_HEADER, QUEUE_PAGE, normalizeEntry, parseQueue, renderQueue } from './queueFormat.js';

const withPoem = (inner: string): string => `${QUEUE_HEADER}<poem>\n${inner}\n</poem>`;

test('队列页标题是那个配置页', () => {
	assert.equal(QUEUE_PAGE, 'User:没有羽翼的格雷塔/BotConfig/FileRestore');
});

// 钉死字面量：这是脚本"内容没变就不写"的判断基底，改动会让每次运行都重写队列页
test('说明文字逐字固定', () => {
	assert.equal(
		QUEUE_HEADER,
		'{{用户 允许他人编辑}}\n需要还原的文件请填入下方<code><nowiki><poem></nowiki></code>标签中，一行一个，带File前缀。填写后请联系[[User talk:没有羽翼的格雷塔|操作者]]手动运行脚本。\n----\n',
	);
});

test('归一文件名：缺 File: 前缀就补上，已有前缀大小写不敏感地保留', () => {
	assert.equal(normalizeEntry('A.png'), 'File:A.png');
	assert.equal(normalizeEntry('File:A.png'), 'File:A.png');
	assert.equal(normalizeEntry('file:A.png'), 'file:A.png');
});

test('解析 <poem> 内的非空行，去首尾空白并去重', () => {
	const content = withPoem('File:A.png\n  File:B.jpg  \n\nFile:A.png\nFile:C.gif');
	assert.deepEqual(parseQueue(content), ['File:A.png', 'File:B.jpg', 'File:C.gif']);
});

test('解析时补 File: 前缀，带与不带的同一文件只留一条', () => {
	const content = withPoem('A.png\nFile:A.png\nB.jpg');
	assert.deepEqual(parseQueue(content), ['File:A.png', 'File:B.jpg']);
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
