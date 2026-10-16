// 实时日志面板：把进度事件逐行铺开。
// 默认自动滚到底；用户往上滚即暂停跟随（给「回到底部」按钮）；「清空」只清本地显示，「复制」写剪贴板。
import { useEffect, useRef, useState } from 'react';
import type { ProgressEvent } from '../types';
import { eventToLine } from './progressText';

interface LogViewProps {
	events: ProgressEvent[];
}

/** 日志级别：决定行文字颜色，log 事件用自带级别，失败的 edit 归为 error */
type LineLevel = 'info' | 'warn' | 'error';

/** 一行日志：文本与级别 */
interface LogEntry {
	text: string;
	level: LineLevel;
}

function lineLevel(event: ProgressEvent): LineLevel {
	if (event.type === 'log') return event.level;
	if (event.type === 'edit' && event.status === 'failed') return 'error';
	return 'info';
}

function toEntry(event: ProgressEvent): LogEntry {
	return { text: eventToLine(event), level: lineLevel(event) };
}

/** 距离底部多少像素内仍算「贴着底部」，用于判断是否继续自动跟随 */
const BOTTOM_THRESHOLD = 24;

/** 日志面板：自动跟随、暂停跟随、清空与复制 */
export function LogView({ events }: LogViewProps): React.JSX.Element {
	const [entries, setEntries] = useState<LogEntry[]>([]);
	// 已消费的事件条数；父组件把 events 缩短（SSE 重连回放先清空再回填）时据此重置本地显示
	const displayed = useRef(0);
	const [following, setFollowing] = useState(true);
	const [copied, setCopied] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (events.length < displayed.current) {
			setEntries(events.map(toEntry));
			displayed.current = events.length;
			return;
		}
		if (events.length === displayed.current) return;
		const appended = events.slice(displayed.current).map(toEntry);
		displayed.current = events.length;
		setEntries((prev) => [...prev, ...appended]);
	}, [events]);

	// 贴着底部时随新行滚动到底
	useEffect(() => {
		if (!following) return;
		const container = containerRef.current;
		if (container) container.scrollTop = container.scrollHeight;
	}, [entries, following]);

	const onScroll = (): void => {
		const container = containerRef.current;
		if (!container) return;
		setFollowing(container.scrollHeight - container.scrollTop - container.clientHeight < BOTTOM_THRESHOLD);
	};

	const backToBottom = (): void => {
		const container = containerRef.current;
		if (container) container.scrollTop = container.scrollHeight;
		setFollowing(true);
	};

	// 只清本地展示：把已消费计数推到当前长度，之后到来的事件照常追加
	const clear = (): void => {
		setEntries([]);
		displayed.current = events.length;
	};

	const copy = (): void => {
		const text = entries.map((entry) => entry.text).join('\n');
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<section className="log-view">
			<div className="log-toolbar">
				<span className="log-title">日志</span>
				<span className="log-count">{entries.length} 行</span>
				<button type="button" onClick={copy}>
					{copied ? '已复制' : '复制'}
				</button>
				<button type="button" onClick={clear}>
					清空
				</button>
				{!following && (
					<button type="button" className="primary" onClick={backToBottom}>
						回到底部
					</button>
				)}
			</div>
			<div className="log-body" ref={containerRef} onScroll={onScroll}>
				{entries.map((entry, index) => (
					<div key={index} className={`log-line log-${entry.level}`}>
						{entry.text}
					</div>
				))}
				{entries.length === 0 && <div className="hint">暂无日志。</div>}
			</div>
		</section>
	);
}
