import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildArgv, type ParamValue, type TaskDescriptor } from '../core/descriptor.js';
import { parseChildLine, type ProgressEvent } from '../core/progress.js';

export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface TaskRecord {
	id: string;
	descriptorId: string;
	label: string;
	argv: string[];
	status: TaskStatus;
	startedAt: number;
	endedAt: number | null;
	events: ProgressEvent[];
	summary: Record<string, number> | null;
}

/** 保留的事件上限，避免长任务把内存吃干 */
export const MAX_EVENTS = 5000;

/** 单任务的编辑结果计数，供 done 事件丢失时的兜底摘要使用 */
interface EditCounts {
	changed: number;
	skipped: number;
	failed: number;
}

/**
 * 追加事件；超过上限时丢弃最旧的一段、保留最新。
 *
 * 长任务里用户关心的是尾部进度，丢头部（历史可查库）而不是丢新事件——
 * 原先"到上限后不再追加"会把之后的 edit 事件全部静默吞掉，task_pages 会不完整。
 */
export function appendCapped(events: ProgressEvent[], event: ProgressEvent, cap: number): void {
	events.push(event);
	if (events.length > cap) events.splice(0, events.length - cap);
}

export function buildChildArgs(entry: string, argv: string[]): string[] {
	return ['--import', 'tsx', entry, ...argv];
}

/**
 * 行切分缓冲。
 *
 * 管道会在任意字节处把输出切断，因此必须跨 chunk 保留状态：
 * - `decoder` 缓存未构成完整 UTF-8 序列的尾部字节（中文占 3 字节，边界落在字符中间尤为常见）
 * - `residual` 缓存尚未出现换行符的半行
 *
 * 二者缺一，整行都会被切坏——事件行一旦被切坏就会 JSON 解析失败而被静默丢弃。
 */
export interface LineBuffer {
	decoder: StringDecoder;
	residual: string;
}

export function createLineBuffer(): LineBuffer {
	return { decoder: new StringDecoder('utf-8'), residual: '' };
}

/** 并入一个字节块，返回其中已完整（以 \n 结尾）的行；末尾半行留在缓冲内待下一块 */
export function feedLineBuffer(buffer: LineBuffer, chunk: Buffer): string[] {
	const text = buffer.residual + buffer.decoder.write(chunk);
	const lines = text.split('\n');
	buffer.residual = lines.pop() ?? '';
	return lines;
}

/** 流结束：把最后一行（可能没有换行结尾）冲出来，并清空缓冲 */
export function flushLineBuffer(buffer: LineBuffer): string[] {
	const tail = buffer.residual + buffer.decoder.end();
	buffer.residual = '';
	return tail.trim() === '' ? [] : [tail];
}

export class TaskRunner {
	private active: TaskRecord | null = null;
	private child: ChildProcess | null = null;
	private readonly bus = new EventEmitter();
	private readonly repoRoot: string;
	/** 各任务的编辑计数；事件缓冲有上限会丢历史，计数必须独立累积 */
	private readonly counters = new Map<string, EditCounts>();

	constructor(repoRoot: string = resolve(process.cwd())) {
		this.repoRoot = repoRoot;
	}

	get current(): TaskRecord | null {
		return this.active;
	}

	/** 启动任务；已有任务在跑时抛错（全局单任务锁） */
	start(descriptor: TaskDescriptor, values: Record<string, ParamValue>, injectedArgs: string[] = []): TaskRecord {
		if (this.active && this.active.status === 'running') {
			throw new Error('已有任务正在运行，请先等待其结束');
		}
		const argv = [...buildArgv(descriptor, values), ...injectedArgs, descriptor.progressFlag];
		const record: TaskRecord = {
			id: randomUUID(),
			descriptorId: descriptor.id,
			label: descriptor.label,
			argv,
			status: 'running',
			startedAt: Date.now(),
			endedAt: null,
			events: [],
			summary: null,
		};
		this.active = record;
		this.counters.set(record.id, { changed: 0, skipped: 0, failed: 0 });

		const child = spawn(process.execPath, buildChildArgs(descriptor.entry, argv), {
			cwd: this.repoRoot,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child = child;

		// 管道会在任意字节处切断，故用 LineBuffer 跨 chunk 保留半行与半个多字节字符。
		const buffers = { info: createLineBuffer(), error: createLineBuffer() };
		const recordLine = (line: string, level: 'info' | 'error') => {
			if (line.trim() === '') return;
			const event = parseChildLine(line);
			// 只把普通日志归到当前流；parseChildLine 已把解析失败降级为 warn，
			// 不要覆盖成 info 而掩盖故障
			if (event.type === 'log' && event.level === 'info') event.level = level;
			this.record(record, event);
		};
		const consume = (chunk: Buffer, level: 'info' | 'error') => {
			for (const line of feedLineBuffer(buffers[level], chunk)) recordLine(line, level);
		};
		// 进程结束时把两个流各自的残行冲出来（最后一行可能没有换行结尾）
		const flush = (level: 'info' | 'error') => {
			for (const line of flushLineBuffer(buffers[level])) recordLine(line, level);
		};

		child.stdout?.on('data', (chunk: Buffer) => consume(chunk, 'info'));
		child.stderr?.on('data', (chunk: Buffer) => consume(chunk, 'error'));

		child.on('error', (error) => {
			this.record(record, { type: 'log', level: 'error', message: error.message, at: Date.now() });
			this.finish(record, 'failed');
		});
		child.on('close', (code) => {
			flush('info');
			flush('error');
			this.finish(record, code === 0 ? 'succeeded' : 'failed');
		});

		return record;
	}

	abort(): boolean {
		if (!this.active || this.active.status !== 'running' || !this.child) return false;
		this.active.status = 'aborted';
		this.child.kill();
		return true;
	}

	subscribe(listener: (task: TaskRecord, event: ProgressEvent) => void): () => void {
		this.bus.on('event', listener);
		return () => this.bus.off('event', listener);
	}

	/** 任务结束时触发一次，用于落库 */
	once(event: 'finish', listener: (task: TaskRecord) => void): void {
		this.bus.once(event, listener);
	}

	private record(record: TaskRecord, event: ProgressEvent): void {
		// 事件缓冲只保留尾部（见 appendCapped），计数器必须独立累积才能在 done 丢失时兜底
		appendCapped(record.events, event, MAX_EVENTS);
		if (event.type === 'edit') {
			const counts = this.counters.get(record.id);
			if (counts) {
				if (event.status === 'changed') counts.changed++;
				else if (event.status === 'skipped') counts.skipped++;
				else counts.failed++;
			}
		}
		if (event.type === 'done') record.summary = event.summary;
		this.bus.emit('event', record, event);
	}

	private finish(record: TaskRecord, status: TaskStatus): void {
		// 幂等：error 与 close 都可能想结束同一个任务
		if (record.endedAt !== null) return;
		// abort() 已把状态置为 aborted，不要被随后的 close 覆盖
		if (record.status === 'running') record.status = status;
		record.endedAt = Date.now();
		if (record.summary === null) {
			// done 事件丢失（子进程被 kill、事件行被切坏等）时用累积的计数兜底，
			// 而不是伪造全零——abort 前往往已完成大量真实编辑，数字必须如实
			const counts = this.counters.get(record.id) ?? { changed: 0, skipped: 0, failed: 0 };
			// 从未产出任何 edit 事件就以 failed 告终（如启动即崩溃）：至少计一次失败
			if (status === 'failed' && counts.changed + counts.skipped + counts.failed === 0) counts.failed = 1;
			record.summary = { changed: counts.changed, staleSkipped: counts.skipped, failed: counts.failed };
		}
		this.counters.delete(record.id);
		this.bus.emit('event', record, { type: 'log', level: 'info', message: `任务结束：${record.status}`, at: Date.now() });
		this.bus.emit('finish', record);
		this.child = null;
	}
}
