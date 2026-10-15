import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRule } from './replaceRules.js';
import { collectMatchLines, listScanResults, readScanResult, scanFileName, writeScanResult, type ScanResult } from './scanResult.js';

const rules = [prepareRule({ from: '苹果', to: '梨' }), prepareRule({ from: '视频', to: '影片' })];

function makeResult(fingerprint: string): ScanResult {
	return {
		version: 1,
		wiki: 'zh',
		fingerprint,
		namespaces: [0],
		rules: [{ from: '苹果', to: '梨' }],
		scanned: 123,
		createdAt: 1700000000000,
		hits: [{ title: '苹果', hits: 1, matches: [{ line: 1, text: '苹果', match: '苹果', rule: 0 }] }],
	};
}

test('命中明细给出行号、该行原文与匹配串', () => {
	const text = '第一行没有\n第二行有苹果和苹果\n第三行是视频\n';
	const detail = collectMatchLines(text, rules);
	assert.equal(detail.hits, 3);
	assert.deepEqual(detail.matches, [
		{ line: 2, text: '第二行有苹果和苹果', match: '苹果', rule: 0 },
		{ line: 2, text: '第二行有苹果和苹果', match: '苹果', rule: 0 },
		{ line: 3, text: '第三行是视频', match: '视频', rule: 1 },
	]);
});

test('CRLF 行尾的 \\r 不进入明细', () => {
	const detail = collectMatchLines('甲\r\n苹果乙\r\n', rules);
	assert.deepEqual(detail.matches, [{ line: 2, text: '苹果乙', match: '苹果', rule: 0 }]);
});

test('明细条数封顶时命中处数仍按真实值记录', () => {
	const text = Array.from({ length: 10 }, (_, i) => `第${i}行有苹果`).join('\n');
	const detail = collectMatchLines(text, rules, 3);
	assert.equal(detail.hits, 10);
	assert.equal(detail.matches.length, 3);
	assert.equal(detail.matches[0].line, 1);
});

test('写入后能按文件名读回，文件名带规则指纹', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-scans-'));
	try {
		const result = makeResult('abcdef012345');
		const name = writeScanResult(dir, result);
		assert.equal(name, scanFileName('zh', 'abcdef012345'));
		assert.deepEqual(readScanResult(dir, name), result);
		assert.deepEqual(listScanResults(dir).map((meta) => meta.hitCount), [1]);
		assert.equal(listScanResults(dir)[0].fingerprint, 'abcdef012345');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('写入时清掉超过保留期的旧结果', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-scans-'));
	try {
		const stale = join(dir, scanFileName('zh', 'deadbeef0000'));
		writeFileSync(stale, '{}', 'utf-8');
		const ancient = new Date(Date.now() - 20 * 86400000);
		utimesSync(stale, ancient, ancient);
		writeScanResult(dir, makeResult('cafebabe0000'));
		assert.deepEqual(readdirSync(dir), [scanFileName('zh', 'cafebabe0000')]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('损坏的结果文件在列表里被跳过、读取返回 null', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-scans-'));
	try {
		const name = scanFileName('zh', '000000000000');
		writeFileSync(join(dir, name), '坏掉的 json', 'utf-8');
		assert.deepEqual(listScanResults(dir), []);
		assert.equal(readScanResult(dir, name), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
