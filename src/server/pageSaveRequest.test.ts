import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePageSaveRequest } from './pageSaveRequest.js';

test('接受合法的保存请求', () => {
	assert.deepEqual(
		parsePageSaveRequest({ page: 'User:X/配置.json', content: '{}', baseRevid: 7 }),
		{ page: 'User:X/配置.json', content: '{}', baseRevid: 7, force: false },
	);
	assert.deepEqual(
		parsePageSaveRequest({ page: '页', content: '{}', baseRevid: null, force: true }),
		{ page: '页', content: '{}', baseRevid: null, force: true },
	);
});

test('标题去空白后不能为空，也不能含换行或控制字符', () => {
	assert.throws(() => parsePageSaveRequest({ page: '   ', content: '{}', baseRevid: null }), /page/);
	assert.throws(() => parsePageSaveRequest({ page: '页\n面', content: '{}', baseRevid: null }), /page/);
	assert.throws(() => parsePageSaveRequest({ page: '页\u0000面', content: '{}', baseRevid: null }), /page/);
});

test('content 必须是字符串，baseRevid 必须是数字或 null，force 必须是布尔', () => {
	assert.throws(() => parsePageSaveRequest({ page: '页', baseRevid: null }), /content/);
	assert.throws(() => parsePageSaveRequest({ page: '页', content: 1, baseRevid: null }), /content/);
	assert.throws(() => parsePageSaveRequest({ page: '页', content: '{}', baseRevid: '7' }), /baseRevid/);
	assert.throws(() => parsePageSaveRequest({ page: '页', content: '{}', baseRevid: 1, force: 'yes' }), /force/);
});

test('非对象请求体一律拒绝', () => {
	assert.throws(() => parsePageSaveRequest(null), /对象/);
	assert.throws(() => parsePageSaveRequest([]), /对象/);
});
