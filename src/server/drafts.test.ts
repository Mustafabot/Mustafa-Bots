import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextDraftStore, safeDraftName } from './drafts.js';

function tempStore(): { store: TextDraftStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'gui-drafts-'));
	return { store: new TextDraftStore(dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('名字里的路径分隔符与冒号被拒绝', () => {
	assert.throws(() => safeDraftName('../逃逸'), /非法/);
	assert.throws(() => safeDraftName('a/b'), /非法/);
	assert.throws(() => safeDraftName(''), /非法/);
	assert.throws(() => safeDraftName('C:evil'), /非法/);
	assert.equal(safeDraftName('上传 任务-1'), '上传 任务-1');
});

test('草稿可写可读可列可删', () => {
	const { store, cleanup } = tempStore();
	try {
		assert.deepEqual(store.list(), []);
		const written = store.write('甲', '{"files":[]}');
		assert.equal(written.name, '甲');
		assert.equal(written.content, '{"files":[]}');
		assert.ok(written.updatedAt > 0);

		assert.equal(store.read('甲')?.content, '{"files":[]}');
		assert.deepEqual(store.list().map((item) => item.name), ['甲']);

		assert.equal(store.remove('甲'), true);
		assert.equal(store.read('甲'), null);
		assert.equal(store.remove('甲'), false);
	} finally {
		cleanup();
	}
});

test('损坏的草稿文件读成 null，不让一个野文件搞崩列表', () => {
	const { store, dir, cleanup } = tempStore();
	try {
		store.write('好', '{}');
		// 直接塞一个坏文件进目录
		writeFileSync(join(dir, '坏.json'), '{不是 json', 'utf-8');
		assert.equal(store.read('坏'), null);
		assert.deepEqual(store.list().map((item) => item.name), ['好']);
	} finally {
		cleanup();
	}
});
