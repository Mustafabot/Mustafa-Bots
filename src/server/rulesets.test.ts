import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RulesetStore, pageTitleFor, safeName } from './rulesets.js';

test('规则集名拼成配置页标题', () => {
	assert.equal(pageTitleFor('文本替换测试'), 'User:没有羽翼的格雷塔/BotConfig/文本替换测试');
});

test('名字里的路径分隔符被拒绝', () => {
	assert.throws(() => safeName('../逃逸'), /非法/);
	assert.throws(() => safeName('a/b'), /非法/);
	assert.throws(() => safeName(''), /非法/);
	assert.equal(safeName('文本替换 测试-1'), '文本替换 测试-1');
});

test('草稿可写可读可列可删', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-rulesets-'));
	const store = new RulesetStore(dir);
	try {
		assert.deepEqual(store.list(), []);
		store.write('甲', '{"rules":[]}', 42);
		const draft = store.read('甲');
		assert.ok(draft);
		assert.equal(draft.content, '{"rules":[]}');
		assert.equal(draft.baseRevid, 42);

		const listed = store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, '甲');
		assert.equal(listed[0].pageTitle, 'User:没有羽翼的格雷塔/BotConfig/甲');

		assert.equal(store.remove('甲'), true);
		assert.equal(store.read('甲'), null);
		assert.equal(store.remove('甲'), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('写入非法名字时抛错且不落盘', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-rulesets-'));
	const store = new RulesetStore(dir);
	try {
		assert.throws(() => store.write('../坏', '{}', null), /非法/);
		assert.deepEqual(store.list(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
