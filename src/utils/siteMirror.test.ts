import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MIRROR_NAMESPACES, SiteMirror } from './siteMirror.js';

test('从未设置过覆盖范围时返回 null，由调用方决定默认值', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const mirror = new SiteMirror(join(dir, 'zh.db'));
	try {
		assert.equal(mirror.getNamespaces(), null);
		assert.deepEqual(DEFAULT_MIRROR_NAMESPACES, { zh: [0], cm: [6] });
	} finally {
		mirror.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('覆盖范围写进 meta 表，重新打开仍在', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const first = new SiteMirror(join(dir, 'zh.db'));
	try {
		first.setNamespaces([0, 6, 10]);
		assert.deepEqual(first.getNamespaces(), [0, 6, 10]);
	} finally {
		first.close();
	}
	const second = new SiteMirror(join(dir, 'zh.db'));
	try {
		assert.deepEqual(second.getNamespaces(), [0, 6, 10]);
	} finally {
		second.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('值损坏时返回 null 而不是抛错', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const mirror = new SiteMirror(join(dir, 'zh.db'));
	try {
		mirror.setMeta('namespaces', '坏掉的 json');
		assert.equal(mirror.getNamespaces(), null);
	} finally {
		mirror.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
