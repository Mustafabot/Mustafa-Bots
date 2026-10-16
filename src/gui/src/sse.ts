// 任务事件流订阅：EventSource 同源自动带 gui_session cookie，服务端每帧是 `data: {...}`。
// 服务端另有 `: ping` 注释帧做保活，注释帧不进 onmessage，这里只会收到真正的 data 帧。
import type { ProgressEvent, TaskMeta } from './types';

/** 每帧负载：任务元信息（TaskRecord 去掉 events）+ 一条进度事件 */
export interface TaskEventFrame {
	task: TaskMeta;
	event: ProgressEvent;
}

/** 连接状态回调：open 为已连上，error 为断开（随后会自动重连） */
export type TaskEventStatus = 'open' | 'error';

/** 断线后重连的间隔（毫秒） */
const RECONNECT_DELAY = 3000;

/**
 * 订阅任务事件流；返回取消函数，组件卸载时务必调用，否则连接与重连定时器会一直存活。
 * 收到一帧就回调 onEvent；连上/断开时回调 onStatus（可选）。
 */
export function subscribeTaskEvents(onEvent: (frame: TaskEventFrame) => void, onStatus?: (status: TaskEventStatus) => void): () => void {
	let source: EventSource | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	const connect = (): void => {
		if (stopped) return;
		const current = new EventSource('/api/task/events');
		source = current;
		current.onopen = () => onStatus?.('open');
		current.onmessage = (message) => {
			try {
				onEvent(JSON.parse(message.data) as TaskEventFrame);
			} catch {
				// 单帧坏掉只丢这一帧，不拖垮整个订阅
			}
		};
		current.onerror = () => {
			onStatus?.('error');
			// 关掉旧连接再手动重连：EventSource 自带的自动重连间隔不可控，
			// 且服务重启后旧连接可能半死，统一改成"3 秒后重建"
			current.close();
			if (source === current) source = null;
			if (stopped || timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				connect();
			}, RECONNECT_DELAY);
		};
	};

	connect();

	return () => {
		stopped = true;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		source?.close();
		source = null;
	};
}
