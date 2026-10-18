import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_UPLOAD_BYTES, parseUploadConfig, validateUploadConfig, type UploadTaskConfig } from './uploadConfig.js';

/** 造一份最小可用的配置；用 overrides 改单个条目 */
function config(entry: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): UploadTaskConfig {
	return parseUploadConfig(JSON.stringify({
		prefix: '12岁。',
		categories: ['萌娘百科'],
		files: [{ url: 'https://example.com/a.jpg', filename: '01.jpg', ...entry }],
		...rest,
	}));
}

test('解析出前缀、分类与逐条字段', () => {
	const parsed = parseUploadConfig(JSON.stringify({
		prefix: '12岁。',
		categories: ['萌娘百科', '动画截图'],
		comment: '自定义摘要',
		files: [{ file: 'C:/tmp/a.png', filename: '01.png', charaName: '某某', author: '某某', source: 'https://example.com', license: 'CC BY-SA' }],
	}));
	assert.equal(parsed.prefix, '12岁。');
	assert.deepEqual(parsed.categories, ['萌娘百科', '动画截图']);
	assert.equal(parsed.comment, '自定义摘要');
	assert.deepEqual(parsed.files, [{
		file: 'C:/tmp/a.png',
		url: undefined,
		filename: '01.png',
		charaName: '某某',
		author: '某某',
		source: 'https://example.com',
		license: 'CC BY-SA',
	}]);
});

test('坏 JSON 与非对象都抛错', () => {
	assert.throws(() => parseUploadConfig('{坏'), /合法的 JSON/);
	assert.throws(() => parseUploadConfig('[]'), /必须是一个对象/);
	assert.throws(() => parseUploadConfig('{"files":{}}'), /files 数组/);
});

test('空文件名与两种来源都给或都不给都要报错', () => {
	const issues = validateUploadConfig(parseUploadConfig(JSON.stringify({
		categories: ['甲'],
		files: [
			{ url: 'https://example.com/a.jpg', filename: '' },
			{ url: 'https://example.com/b.jpg', file: 'C:/tmp/b.jpg', filename: 'b.jpg' },
			{ filename: 'c.jpg' },
		],
	})));
	const joined = issues.map((issue) => `${issue.index} ${issue.message}`).join('\n');
	assert.match(joined, /filename 不能为空/);
	assert.match(joined, /只能给一个/);
	assert.match(joined, /必须给出 url 或 file/);
});

test('URL 协议与格式被检查', () => {
	const issues = validateUploadConfig(parseUploadConfig(JSON.stringify({
		categories: ['甲'],
		files: [
			{ url: 'ftp://example.com/a.jpg', filename: 'a.jpg' },
			{ url: '不是地址', filename: 'b.jpg' },
		],
	})));
	assert.equal(issues.length, 2);
	assert.match(issues[0].message, /协议必须是 http 或 https/);
	assert.match(issues[1].message, /URL 格式无效/);
});

test('本机文件存在性与大小按探针结果判断', () => {
	const parsed = parseUploadConfig(JSON.stringify({
		categories: ['甲'],
		files: [
			{ file: 'C:/tmp/没有这个文件.png', filename: 'a.png' },
			{ file: 'C:/tmp/太大了.png', filename: 'b.png' },
		],
	}));
	const issues = validateUploadConfig(parsed, (path) => (path.includes('没有') ? { exists: false, size: null } : { exists: true, size: MAX_UPLOAD_BYTES + 1 }));
	assert.equal(issues.length, 2);
	assert.match(issues[0].message, /本机文件不存在/);
	assert.match(issues[1].message, /超过 20 MB/);
});

test('拼上前缀之后重名要报错，指出与哪一条重了', () => {
	const issues = validateUploadConfig(parseUploadConfig(JSON.stringify({
		prefix: '12岁。',
		categories: ['甲'],
		files: [
			{ url: 'https://example.com/a.jpg', filename: '01.jpg' },
			{ url: 'https://example.com/b.jpg', filename: '01.jpg' },
		],
	})));
	assert.equal(issues.length, 1);
	assert.match(issues[0].message, /与第 1 条重复/);
	assert.match(issues[0].message, /12岁。01\.jpg/);
});

test('没有分类且该条三项信息全缺要报错，有一条信息就放行', () => {
	const noInfo = validateUploadConfig(parseUploadConfig(JSON.stringify({ files: [{ url: 'https://example.com/a.jpg', filename: 'a.jpg' }] })));
	assert.equal(noInfo.length, 1);
	assert.match(noInfo[0].message, /至少要填一项/);

	const withSource = validateUploadConfig(parseUploadConfig(JSON.stringify({
		files: [{ url: 'https://example.com/a.jpg', filename: 'a.jpg', source: 'https://example.com' }],
	})));
	assert.deepEqual(withSource, []);
});

test('批量上传不许用「原作者授权萌百使用」', () => {
	const issues = validateUploadConfig(config({ license: 'none:gotoCommons' }));
	assert.equal(issues.length, 1);
	assert.match(issues[0].message, /批量上传不允许/);
});

test('不认识的授权协议也要被拦下', () => {
	const issues = validateUploadConfig(config({ license: '不是协议' }));
	assert.equal(issues.length, 1);
	assert.match(issues[0].message, /不认识的授权协议/);
});

test('没有文件时报整体性错误', () => {
	const issues = validateUploadConfig(parseUploadConfig('{"files":[]}'));
	assert.equal(issues.length, 1);
	assert.equal(issues[0].index, 0);
});
