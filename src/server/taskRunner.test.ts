import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCapped, MAX_EVENTS, TaskRunner, buildChildArgs, createLineBuffer, feedLineBuffer, flushLineBuffer } from './taskRunner.js';
import type { TaskDescriptor } from '../core/descriptor.js';
import { EVENT_PREFIX, parseChildLine, type ProgressEvent } from '../core/progress.js';

test('子进程参数用当前 node 加 tsx 加载器，避免依赖 npx 与 shell 引号', () => {
	const args = buildChildArgs('src/replace/TextReplace.ts', ['--wiki', 'zh', '--dry-run']);
	assert.equal(args[0], '--import');
	assert.equal(args[1], 'tsx');
	assert.equal(args[2], 'src/replace/TextReplace.ts');
	assert.deepEqual(args.slice(3), ['--wiki', 'zh', '--dry-run']);
});

test('一行事件被切成两个 chunk 后仍还原为一条完整事件', () => {
	const buffer = createLineBuffer();
	const line = '__MWBOT_EVENT__ {"type":"done","summary":{"changed":3},"at":1}\n';
	const half = Math.floor(line.length / 2);
	const first = feedLineBuffer(buffer, Buffer.from(line.slice(0, half), 'utf-8'));
	const second = feedLineBuffer(buffer, Buffer.from(line.slice(half), 'utf-8'));
	const lines = [...first, ...second];
	assert.equal(lines.length, 1, '被切开的行只能产出一次');
	const event = parseChildLine(lines[0]);
	assert.deepEqual(event, { type: 'done', summary: { changed: 3 }, at: 1 });
});

test('多字节汉字被切成两个 chunk 后不产生替换字符', () => {
	const buffer = createLineBuffer();
	const bytes = Buffer.from('标题甲\n', 'utf-8');
	// “标”占 3 字节，从第 1 字节后切开，正好落在字符中间
	const lines = [
		...feedLineBuffer(buffer, bytes.subarray(0, 1)),
		...feedLineBuffer(buffer, bytes.subarray(1)),
	];
	assert.deepEqual(lines, ['标题甲']);
	assert.ok(!lines.join('').includes('�'), '不应出现 UTF-8 替换字符');
});

test('最后一行没有换行结尾时由 flush 冲出，且重复 flush 不再吐行', () => {
	const buffer = createLineBuffer();
	assert.deepEqual(feedLineBuffer(buffer, Buffer.from('无换行日志', 'utf-8')), []);
	assert.deepEqual(flushLineBuffer(buffer), ['无换行日志']);
	assert.deepEqual(flushLineBuffer(buffer), [], 'flush 后缓冲应为空');
});

test('一个 chunk 内的多行逐行产出，末尾半行留待下一 chunk', () => {
	const buffer = createLineBuffer();
	assert.deepEqual(feedLineBuffer(buffer, Buffer.from('一\n二\n三', 'utf-8')), ['一', '二']);
	assert.deepEqual(feedLineBuffer(buffer, Buffer.from('四\n', 'utf-8')), ['三四']);
});

test('事件缓冲达到上限后保留最新一端，丢掉最旧的', () => {
	const events: ProgressEvent[] = [];
	for (let i = 0; i < 5; i++) appendCapped(events, { type: 'hit', title: `页${i}`, at: i }, 3);
	assert.deepEqual(
		events.map((event) => (event.type === 'hit' ? event.title : null)),
		['页2', '页3', '页4'],
	);
});

test('事件量超过 MAX_EVENTS 时缓冲只留最后 MAX_EVENTS 条', () => {
	const events: ProgressEvent[] = [];
	const total = MAX_EVENTS + 3;
	for (let i = 0; i < total; i++) {
		appendCapped(events, { type: 'log', level: 'info', message: `第${i}条`, at: i }, MAX_EVENTS);
	}
	assert.equal(events.length, MAX_EVENTS);
	const first = events[0];
	const last = events[events.length - 1];
	assert.equal(first.type === 'log' ? first.message : null, '第3条');
	assert.equal(last.type === 'log' ? last.message : null, `第${total - 1}条`);
});

/** 写一个临时子脚本：往 stdout 发若干事件，可选地不发 done 就退出 */
function writeChildScript(dir: string, body: string): string {
	const file = join(dir, 'child.mjs');
	writeFileSync(file, body, 'utf-8');
	return file;
}

test('done 缺失时兜底汇总用真实计数，且计数不受事件缓冲截断影响', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-runner-'));
	try {
		// 先倒 6000 条噪音日志把事件缓冲挤到上限，再发 4 条 edit，
		// 用来证明计数器独立于缓冲：缓冲只剩尾部，汇总却必须是全程真实值
		const script = writeChildScript(
			dir,
			[
				`const emit = (event) => process.stdout.write('${EVENT_PREFIX}' + JSON.stringify(event) + '\\n');`,
				`for (let i = 0; i < 6000; i++) emit({ type: 'log', level: 'info', message: '噪音' + i, at: i });`,
				`emit({ type: 'edit', title: '甲', status: 'changed', oldRevid: 1, newRevid: 2, at: 1 });`,
				`emit({ type: 'edit', title: '乙', status: 'changed', oldRevid: 3, newRevid: 4, at: 2 });`,
				`emit({ type: 'edit', title: '丙', status: 'skipped', oldRevid: 5, newRevid: null, at: 3 });`,
				`emit({ type: 'edit', title: '丁', status: 'failed', oldRevid: null, newRevid: null, at: 4 });`,
			].join('\n'),
		);
		const descriptor: TaskDescriptor = {
			id: 'child-no-done',
			label: '不发 done 的子进程',
			entry: script,
			style: 'space',
			progressFlag: '--progress-json',
			quietFlag: '--quiet',
			params: [],
		};
		const runner = new TaskRunner();
		const finished = new Promise<void>((resolve) => runner.once('finish', () => resolve()));
		const record = runner.start(descriptor, {});
		await finished;

		assert.deepEqual(record.summary, { changed: 2, staleSkipped: 1, failed: 1 });
		// 缓冲确实被截断了（6004 条事件只留 5000），但汇总仍是全程真实计数
		assert.equal(record.events.length, MAX_EVENTS);
		assert.equal(record.status, 'succeeded');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('计数按任务隔离，失败任务的兜底不会沿用上一任务的数字', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-runner-'));
	try {
		const script = writeChildScript(
			dir,
			[
				`const emit = (event) => process.stdout.write('${EVENT_PREFIX}' + JSON.stringify(event) + '\\n');`,
				`emit({ type: 'edit', title: '甲', status: 'changed', oldRevid: 1, newRevid: 2, at: 1 });`,
			].join('\n'),
		);
		const descriptor: TaskDescriptor = {
			id: 'child-counters',
			label: '计数隔离测试',
			entry: script,
			style: 'space',
			progressFlag: '--progress-json',
			quietFlag: '--quiet',
			params: [],
		};
		const runner = new TaskRunner();
		const first = new Promise<void>((resolve) => runner.once('finish', () => resolve()));
		const firstRecord = runner.start(descriptor, {});
		await first;
		assert.deepEqual(firstRecord.summary, { changed: 1, staleSkipped: 0, failed: 0 });

		// 第二个任务一个 edit 事件都没有就失败退出：兜底应是「一次失败」，
		// 而不是把上一任务的 changed: 1 带过来
		const failingScript = join(dir, 'failing.mjs');
		writeFileSync(failingScript, 'process.exit(1);\n', 'utf-8');
		const failingDescriptor: TaskDescriptor = { ...descriptor, id: 'child-no-edit', entry: failingScript };
		const second = new Promise<void>((resolve) => runner.once('finish', () => resolve()));
		const secondRecord = runner.start(failingDescriptor, {});
		await second;
		assert.deepEqual(secondRecord.summary, { changed: 0, staleSkipped: 0, failed: 1 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
