import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
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
const MAX_EVENTS = 5000;

export function buildChildArgs(entry: string, argv: string[]): string[] {
	return ['--import', 'tsx', entry, ...argv];
}

export class TaskRunner {
	private active: TaskRecord | null = null;
	private child: ChildProcess | null = null;
	private readonly bus = new EventEmitter();
	private readonly repoRoot: string;

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

		const child = spawn(process.execPath, buildChildArgs(descriptor.entry, argv), {
			cwd: this.repoRoot,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child = child;

		const consume = (chunk: Buffer, level: 'info' | 'error') => {
			for (const line of chunk.toString('utf-8').split('\n')) {
				if (line.trim() === '') continue;
				const event = parseChildLine(line);
				if (event.type === 'log') event.level = level;
				this.record(record, event);
			}
		};
		child.stdout?.on('data', (chunk: Buffer) => consume(chunk, 'info'));
		child.stderr?.on('data', (chunk: Buffer) => consume(chunk, 'error'));

		child.on('error', (error) => {
			this.record(record, { type: 'log', level: 'error', message: error.message, at: Date.now() });
			this.finish(record, 'failed');
		});
		child.on('close', (code) => {
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
		if (record.events.length < MAX_EVENTS) record.events.push(event);
		if (event.type === 'done') record.summary = event.summary;
		this.bus.emit('event', record, event);
	}

	private finish(record: TaskRecord, status: TaskStatus): void {
		// 幂等：error 与 close 都可能想结束同一个任务
		if (record.endedAt !== null) return;
		// abort() 已把状态置为 aborted，不要被随后的 close 覆盖
		if (record.status === 'running') record.status = status;
		record.endedAt = Date.now();
		if (record.summary === null) record.summary = { changed: 0, staleSkipped: 0, failed: status === 'failed' ? 1 : 0 };
		this.bus.emit('event', record, { type: 'log', level: 'info', message: `任务结束：${record.status}`, at: Date.now() });
		this.bus.emit('finish', record);
		this.child = null;
	}
}
