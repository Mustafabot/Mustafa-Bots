import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUploadTask, encodeUploadTask, makeRow, type UploadFormState } from './uploadTaskCodec';

test('编码时省略空字段，只留填过的', () => {
	const state: UploadFormState = {
		prefix: '12岁。',
		categories: ['萌娘百科'],
		comment: '',
		rows: [{ ...makeRow({ url: 'https://example.com/a.jpg' }), filename: '01.jpg', license: 'CC BY-SA' }],
	};
	assert.deepEqual(JSON.parse(encodeUploadTask(state)), {
		prefix: '12岁。',
		categories: ['萌娘百科'],
		files: [{ url: 'https://example.com/a.jpg', filename: '01.jpg', license: 'CC BY-SA' }],
	});
});

test('编解码往返保留填过的内容', () => {
	const state: UploadFormState = {
		prefix: '前缀 ',
		categories: ['甲', '乙'],
		comment: '机器人：定制摘要',
		rows: [{ ...makeRow({ file: 'C:/tmp/a.png' }), filename: 'a.png', charaName: '某某', author: '某某', source: 'https://example.com' }],
	};
	const back = decodeUploadTask(encodeUploadTask(state));
	assert.equal(back.prefix, '前缀 ');
	assert.deepEqual(back.categories, ['甲', '乙']);
	assert.equal(back.comment, '机器人：定制摘要');
	assert.equal(back.rows.length, 1);
	assert.equal(back.rows[0].file, 'C:/tmp/a.png');
	assert.equal(back.rows[0].filename, 'a.png');
	assert.equal(back.rows[0].charaName, '某某');
});

test('坏 JSON 或缺 files 时退回空表单，界面永远拿到能渲染的状态', () => {
	assert.deepEqual(decodeUploadTask('{坏').rows, []);
	assert.deepEqual(decodeUploadTask('{"files":"不是数组"}').rows, []);
	assert.deepEqual(decodeUploadTask('[]').rows, []);
});

test('解码时每行都拿到互不相同的 id', () => {
	const back = decodeUploadTask('{"files":[{"url":"https://a/1.jpg"},{"url":"https://a/2.jpg"}]}');
	assert.notEqual(back.rows[0].id, back.rows[1].id);
	assert.equal(back.rows[0].filename, '');
});

test('粘贴地址时按末段预填文件名', () => {
	const row = makeRow({ url: 'https://example.com/path/280px-demo.png?x=1' });
	assert.equal(row.filename, '280px-demo.png');
	assert.equal(makeRow({ url: 'https://example.com/' }).filename, '');
	assert.equal(makeRow({ file: 'C:/tmp/b.png' }).filename, 'b.png');
});

test('末段含裸 % 时退回原文，不抛错', () => {
	// decodeURIComponent('100%off.png') 会抛 URIError；这里应退回原样，而不是让整批粘贴丢掉
	assert.equal(makeRow({ url: 'https://example.com/100%off.png' }).filename, '100%off.png');
	// 正常编码的末段仍照常解码
	assert.equal(makeRow({ url: 'https://example.com/%E5%9B%BE.png' }).filename, '图.png');
});
