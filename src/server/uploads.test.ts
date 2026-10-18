import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUploadName } from './uploads.js';

test('上传文件名只取基本名并挡掉逃逸', () => {
	assert.equal(safeUploadName('图片.png'), '图片.png');
	// 浏览器可能把整条路径塞进 name，只取最后一段
	assert.equal(safeUploadName('C:\\Users\\me\\图片.png'), '图片.png');
	assert.equal(safeUploadName('../../etc/passwd'), 'passwd');
	assert.throws(() => safeUploadName(''), /文件名/);
	assert.throws(() => safeUploadName('..'), /文件名/);
	assert.throws(() => safeUploadName('a/b/..'), /文件名/);
	// 控制字符会污染响应头与文件系统，一并拒掉
	assert.throws(() => safeUploadName('a\r\nb.png'), /文件名/);
	assert.throws(() => safeUploadName('图片\u0000.png'), /文件名/);
});
