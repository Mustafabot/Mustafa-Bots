import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint, describeRule, prepareRule, validateRule } from './replaceRules.js';

test('缺 from 或缺 to 时给出校验错误', () => {
	assert.equal(validateRule({ from: '', to: 'x' }, '规则'), '规则 缺少 from');
	assert.equal(validateRule({ from: 'a', to: undefined as unknown as string }, '规则'), '规则 缺少 to（可为空串）');
});

test('纯文本规则不允许 from 与 to 相同', () => {
	assert.equal(validateRule({ from: '苹果', to: '苹果' }, '规则'), '规则 from 与 to 相同');
});

test('非法正则被拒绝，错误里带原因', () => {
	const message = validateRule({ from: 'a(', to: 'b', regex: true }, '规则');
	assert.ok(message?.includes('from 不是合法正则'));
});

test('纯文本规则按字面替换，$ 不被解释', () => {
	const prepared = prepareRule({ from: 'a', to: '$1x' });
	assert.deepEqual(prepared.apply('a-a'), { text: '$1x-$1x', count: 2 });
});

test('忽略大小写的纯文本规则，to 里的 $ 按字面替换', () => {
	const prepared = prepareRule({ from: '苹果', to: '$&/$1/$', ignoreCase: true });
	assert.deepEqual(prepared.apply('苹果'), { text: '$&/$1/$', count: 1 });
});

test('正则规则支持 $1 引用', () => {
	const prepared = prepareRule({ from: '(\\w+)→(\\w+)', to: '$2→$1', regex: true });
	assert.deepEqual(prepared.apply('a→b c→d'), { text: 'b→a d→c', count: 2 });
});

test('忽略大小写把纯文本当成不区分大小写的正则', () => {
	const prepared = prepareRule({ from: 'ABC', to: 'x', ignoreCase: true });
	assert.equal(prepared.countMatches('abc AbC'), 2);
	assert.equal(prepared.apply('abc').text, 'x');
});

test('findMatches 给出全文下标与实际匹配串', () => {
	const prepared = prepareRule({ from: '苹果', to: '梨' });
	assert.deepEqual(prepared.findMatches('苹果 梨 苹果'), [
		{ index: 0, value: '苹果' },
		{ index: 5, value: '苹果' },
	]);
});

test('零宽匹配不会让 findMatches 陷入死循环', () => {
	const prepared = prepareRule({ from: 'a*', to: '', regex: true });
	// /a*/ 在 'bbb' 的 4 个空位各匹配一次，必须能返回而不是卡死
	assert.equal(prepared.findMatches('bbb').length, 4);
});

test('空 from 的纯文本规则 findMatches 返回空数组而非死循环', () => {
	assert.deepEqual(prepareRule({ from: '', to: 'x' }).findMatches('abc'), []);
});

test('指纹随规则与站点变化，同参数稳定不变', () => {
	const base = { wiki: 'zh', namespaces: [0], rules: [{ from: 'a', to: 'b' }] };
	const first = computeFingerprint(base);
	assert.equal(first, computeFingerprint({ wiki: 'zh', namespaces: [0], rules: [{ from: 'a', to: 'b' }] }));
	assert.notEqual(first, computeFingerprint({ ...base, rules: [{ from: 'a', to: 'c' }] }));
	assert.notEqual(first, computeFingerprint({ ...base, wiki: 'cm' }));
	assert.notEqual(first, computeFingerprint({ ...base, titles: ['页面'] }));
});

test('describeRule 把过长内容截断到 40 字', () => {
	assert.equal(describeRule({ from: 'a'.repeat(60), to: '' }), `"${'a'.repeat(40)}…" → ""`);
});
