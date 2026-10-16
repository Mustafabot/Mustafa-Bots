// 任务运行编排：订阅 SSE + 启动/中止 + 维护任务状态与事件流。
//
// 从 Task 5 的 RunPage 里抽出来，供通用运行页与文本替换页共用——
// 两处都要"跑一个任务、看进度、能中止"，复制的代价是两份行为迟早走偏。
// 事件来自服务端，关掉页面再回来（或刷新）能从 api.task.get() + SSE 回放里恢复。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { subscribeTaskEvents } from '../sse';
import type { ProgressEvent, StartTaskBody, TaskRecord } from '../types';

/** 一个任务跑到 done 时交给调用方的信息 */
export interface TaskDoneInfo {
	taskId: string;
	summary: Record<string, number>;
	/** 扫描类任务的落盘结果文件名（文本替换的 `--scan-only` 会带） */
	resultFile?: string;
	/** 该任务的完整事件序列（含本条 done 事件），供调用方按 edit 事件做汇总 */
	events: ProgressEvent[];
}

export interface TaskRun {
	task: TaskRecord | null;
	events: ProgressEvent[];
	/** 启动或中止请求进行中 */
	busy: boolean;
	error: string | null;
	/** 启动任务；成功返回任务记录，失败返回 null 并写入 error */
	start: (body: StartTaskBody) => Promise<TaskRecord | null>;
	abort: () => Promise<void>;
	setError: (message: string | null) => void;
}

/**
 * 订阅任务事件流并维护运行状态。
 * `onDone` 在某个任务的 done 事件到达时回调一次（同一任务重连回放不会重复触发）；
 * 回调里要读"到本条为止"的完整事件，故一并传入事件快照。
 */
export function useTaskRun(onDone?: (info: TaskDoneInfo) => void): TaskRun {
	const [task, setTask] = useState<TaskRecord | null>(null);
	const [events, setEvents] = useState<ProgressEvent[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 记住当前事件属于哪个任务：换了任务就重置事件数组，避免上一个任务的日志混进新任务
	const taskIdRef = useRef<string | null>(null);
	// 事件的最新快照：setState 是异步批处理的，done 回调里读 state 拿不到本条
	const eventsRef = useRef<ProgressEvent[]>([]);
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;
	// 已回调过 done 的任务 id：SSE 重连会重放事件，靠它去重
	const reportedDone = useRef<Set<string>>(new Set());

	// 进页面先取当前任务（任务状态在服务端，刷新后仍在）
	useEffect(() => {
		let alive = true;
		api.task
			.get()
			.then((result) => {
				if (alive && result.task) {
					taskIdRef.current = result.task.id;
					setTask(result.task);
				}
			})
			.catch(() => {
				// 登录门已在 App 处理；这里拿不到任务就当作没有任务
			});
		return () => {
			alive = false;
		};
	}, []);

	// 订阅事件流：服务端连接后会把当前任务的既有事件重放一遍，再增量推送
	useEffect(
		() =>
			subscribeTaskEvents(
				(frame) => {
					const isNewTask = taskIdRef.current !== frame.task.id;
					taskIdRef.current = frame.task.id;
					const next = isNewTask ? [frame.event] : [...eventsRef.current, frame.event];
					eventsRef.current = next;
					setEvents(next);
					setTask({ ...frame.task, events: [] });
					if (frame.event.type === 'done' && !reportedDone.current.has(frame.task.id)) {
						reportedDone.current.add(frame.task.id);
						onDoneRef.current?.({ taskId: frame.task.id, summary: frame.event.summary, resultFile: frame.event.resultFile, events: next });
					}
				},
				(status) => {
					// 每次（重）连上都会重放完整事件，先清空以免重连后重复
					if (status === 'open') {
						eventsRef.current = [];
						setEvents([]);
					}
				},
			),
		[],
	);

	const start = useCallback(async (body: StartTaskBody): Promise<TaskRecord | null> => {
		setBusy(true);
		setError(null);
		try {
			const result = await api.task.start(body);
			setTask(result.task);
			return result.task;
		} catch (reason) {
			setError(reason instanceof ApiError ? reason.message : '启动任务失败');
			return null;
		} finally {
			setBusy(false);
		}
	}, []);

	const abort = useCallback(async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await api.task.abort();
		} catch (reason) {
			setError(reason instanceof ApiError ? reason.message : '中止任务失败');
		} finally {
			setBusy(false);
		}
	}, []);

	return { task, events, busy, error, start, abort, setError };
}
