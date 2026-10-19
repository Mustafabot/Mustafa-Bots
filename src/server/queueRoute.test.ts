import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueueSaveRequest } from './queueRequest.js';

test('接受字符串数组与可空基线', () => {
	assert.deepEqual(parseQueueSaveRequest({ entries: ['File:A.png'], baseRevid: 3 }), { entries: ['File:A.png'], baseRevid: 3, force: false });
	assert.deepEqual(parseQueueSaveRequest({ entries: [], baseRevid: null }), { entries: [], baseRevid: null, force: false });
});

test('拒绝缺字段与错类型', () => {
	assert.throws(() => parseQueueSaveRequest({}), /entries/);
	assert.throws(() => parseQueueSaveRequest({ entries: 'File:A.png', baseRevid: 1 }), /entries/);
	assert.throws(() => parseQueueSaveRequest({ entries: ['File:A.png'], baseRevid: '1' }), /baseRevid/);
	assert.throws(() => parseQueueSaveRequest({ entries: ['File:A.png'], baseRevid: 1, force: 'yes' }), /force/);
});

test('条目去空白、去空、去重', () => {
	assert.deepEqual(parseQueueSaveRequest({ entries: [' File:A.png ', '', 'File:A.png', 'File:B.png'], baseRevid: 1 }).entries, ['File:A.png', 'File:B.png']);
});

test('非字符串元素一律拒绝，不静默丢成空清单把队列清空', () => {
	assert.throws(() => parseQueueSaveRequest({ entries: [123], baseRevid: 1 }), /字符串/);
	assert.throws(() => parseQueueSaveRequest({ entries: ['File:A.png', null], baseRevid: 1 }), /字符串/);
});

test('条目归一为带 File: 前缀', () => {
	assert.deepEqual(parseQueueSaveRequest({ entries: ['A.png', 'File:B.png'], baseRevid: 1 }).entries, ['File:A.png', 'File:B.png']);
});
