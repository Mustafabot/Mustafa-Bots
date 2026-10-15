import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFileName, writeScanResult, type ScanResult } from '../replace/scanResult.js';
import { ScanStore } from './scans.js';

function seed(dir: string): string {
	const hits = Array.from({ length: 5 }, (_, i) => ({
		title: `页面${i}`,
		hits: 1,
		matches: [{ line: 1, text: `页面${i} 有苹果`, match: '苹果', rule: 0 }],
	}));
	const result: ScanResult = {
		version: 1,
		wiki: 'zh',
		fingerprint: 'abcdef012345',
		namespaces: [0],
		rules: [{ from: '苹果', to: '梨' }],
		scanned: 10,
		createdAt: 1700000000000,
		hits,
	};
	return writeScanResult(dir, result);
}

test('列表返回元信息，分页返回命中页切片', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-scans-api-'));
	try {
		const name = seed(dir);
		const store = new ScanStore(dir);
		assert.equal(store.list().length, 1);
		assert.equal(store.list()[0].hitCount, 5);

		const page = store.page(name, 1, 2);
		assert.ok(page);
		assert.equal(page.total, 5);
		assert.equal(page.offset, 1);
		assert.equal(page.limit, 2);
		assert.deepEqual(page.hits.map((hit) => hit.title), ['页面1', '页面2']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('文件名走白名单，路径穿越一律当作不存在', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-scans-api-'));
	try {
		seed(dir);
		const store = new ScanStore(dir);
		assert.equal(store.page('../history.db', 0, 10), null);
		assert.equal(store.page('..\\history.db', 0, 10), null);
		assert.equal(store.page('/etc/passwd', 0, 10), null);
		assert.equal(store.page('scan_zh_../../../etc.json', 0, 10), null);
		assert.equal(store.page('别的名字.json', 0, 10), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('目录不存在时列表为空，不抛错', () => {
	const store = new ScanStore(join(tmpdir(), 'gui-scans-api-不存在的目录'));
	assert.deepEqual(store.list(), []);
});
