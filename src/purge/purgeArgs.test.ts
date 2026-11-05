import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, parseArgs } from './purgeArgs.js';

test('取位置参数为标题，其余取默认值', () => {
	const args = parseArgs(['页面标题'])!;
	assert.equal(args.title, '页面标题');
	assert.equal(args.dryRun, false);
	assert.equal(args.nulledit, false);
	assert.equal(args.verbose, true);
	assert.equal(args.progressJson, false);
	assert.equal(args.concurrency, DEFAULT_CONCURRENCY);
});

test('识别各个开关', () => {
	const args = parseArgs(['页面', '--nulledit', '--dry-run', '--quiet', '--progress-json'])!;
	assert.equal(args.title, '页面');
	assert.equal(args.nulledit, true);
	assert.equal(args.dryRun, true);
	assert.equal(args.verbose, false);
	assert.equal(args.progressJson, true);
});

test('--concurrency 与 -c 都能取到值', () => {
	assert.equal(parseArgs(['页面', '--concurrency', '5'])!.concurrency, 5);
	assert.equal(parseArgs(['页面', '-c', '7'])!.concurrency, 7);
});

test('非法并发数回退默认值', () => {
	assert.equal(parseArgs(['页面', '--concurrency', 'abc'])!.concurrency, DEFAULT_CONCURRENCY);
	assert.equal(parseArgs(['页面', '--concurrency', '0'])!.concurrency, DEFAULT_CONCURRENCY);
	assert.equal(parseArgs(['页面', '--concurrency', '-3'])!.concurrency, DEFAULT_CONCURRENCY);
});

test('并发数超过上限被截断', () => {
	assert.equal(parseArgs(['页面', '--concurrency', '999'])!.concurrency, MAX_CONCURRENCY);
});

test('缺页面标题时返回 null', () => {
	assert.equal(parseArgs([]), null);
	assert.equal(parseArgs(['--dry-run', '--quiet']), null);
});

test('未知开关被忽略，不影响标题与已知参数', () => {
	const args = parseArgs(['页面', '--nonsense', '--progress-json'])!;
	assert.equal(args.title, '页面');
	assert.equal(args.progressJson, true);
});
