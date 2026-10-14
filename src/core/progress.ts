/**
 * 脚本与 GUI 之间的进度协议。
 *
 * 事件以单行 NDJSON 写入 stdout，带固定前缀，因此可以与人类可读日志共用同一路输出，
 * 不需要额外的文件描述符（Windows 上扩展 fd 不可靠）。
 */

export const EVENT_PREFIX = '__MWBOT_EVENT__ ';

export type ProgressEvent =
	| { type: 'start'; task: string; at: number }
	| { type: 'phase'; name: string; at: number }
	| { type: 'progress'; done: number; total?: number; message?: string; at: number }
	| { type: 'hit'; title: string; at: number }
	| {
			type: 'edit';
			title: string;
			status: 'changed' | 'skipped' | 'failed';
			oldRevid: number | null;
			newRevid: number | null;
			message?: string;
			at: number;
	  }
	| { type: 'done'; summary: Record<string, number>; at: number }
	| { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };

/** Omit 作用在联合类型上会塌缩，必须逐分支分发 */
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EmitProgress = (event: DistributedOmit<ProgressEvent, 'at'>) => void;

/** 构造发射器；enabled 为 false 时是空操作，保证普通命令行运行不产生事件输出 */
export function createEmitter(enabled: boolean): EmitProgress {
	return (event) => {
		if (!enabled) return;
		process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ ...event, at: Date.now() })}\n`);
	};
}

/** 解析子进程的一行输出：带前缀的还原为事件，其余包装为 info 日志 */
export function parseChildLine(line: string): ProgressEvent {
	const trimmed = line.replace(/[\r\n]+$/, '');
	if (trimmed.startsWith(EVENT_PREFIX)) {
		try {
			return JSON.parse(trimmed.slice(EVENT_PREFIX.length)) as ProgressEvent;
		} catch {
			return { type: 'log', level: 'warn', message: `无法解析事件行: ${trimmed}`, at: Date.now() };
		}
	}
	return { type: 'log', level: 'info', message: trimmed, at: Date.now() };
}
