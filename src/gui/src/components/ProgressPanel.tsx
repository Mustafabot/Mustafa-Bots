// 进度面板：状态徽章 + 用时 + 分阶段进度条 + 中止按钮。
// 进度条取值来自 progress 事件的 done/total；没有 total 时用不定长条。阶段由 phase 事件分组。
import { useEffect, useState } from 'react';
import type { ProgressEvent, TaskRecord, TaskStatus } from '../types';
import { formatDuration } from './progressText';

interface ProgressPanelProps {
	task: TaskRecord | null;
	events: ProgressEvent[];
	onAbort: () => void;
	/** 中止请求进行中，按钮显示为「中止中…」并禁用 */
	aborting?: boolean;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
	running: '运行中',
	succeeded: '成功',
	failed: '失败',
	aborted: '已中止',
};

/** 一个阶段的进度行 */
interface PhaseRow {
	name: string;
	done: number;
	total?: number;
	message?: string;
	hasProgress: boolean;
}

/** 按 phase 事件把 progress 事件分组；phase 之前出现的 progress 归入「运行」一组 */
function collectPhases(events: ProgressEvent[]): PhaseRow[] {
	const rows: PhaseRow[] = [];
	let current: PhaseRow | null = null;
	for (const event of events) {
		if (event.type === 'phase') {
			current = { name: event.name, done: 0, hasProgress: false };
			rows.push(current);
		} else if (event.type === 'progress') {
			if (current === null) {
				current = { name: '运行', done: 0, hasProgress: false };
				rows.push(current);
			}
			current.done = event.done;
			current.total = event.total;
			current.message = event.message;
			current.hasProgress = true;
		}
	}
	return rows;
}

/** 统计 edit 事件里各类结果的数量 */
function countEdits(events: ProgressEvent[]): { changed: number; skipped: number; failed: number } {
	let changed = 0;
	let skipped = 0;
	let failed = 0;
	for (const event of events) {
		if (event.type !== 'edit') continue;
		if (event.status === 'changed') changed++;
		else if (event.status === 'skipped') skipped++;
		else failed++;
	}
	return { changed, skipped, failed };
}

/** 一条进度条；total 有值时按比例，否则不定长 */
function PhaseBar({ row }: { row: PhaseRow }): React.JSX.Element {
	const determinate = row.hasProgress && row.total !== undefined;
	const percent = determinate && row.total! > 0 ? Math.min(100, Math.round((row.done / row.total!) * 100)) : 0;
	return (
		<div className="phase-row">
			<div className="phase-name">{row.name}</div>
			<div className={`bar${determinate ? '' : ' bar-indeterminate'}`}>
				<div className="bar-fill" style={determinate ? { width: `${percent}%` } : undefined} />
			</div>
			<div className="phase-count">{row.hasProgress ? (row.total === undefined ? `${row.done}` : `${row.done}/${row.total}`) : ''}</div>
		</div>
	);
}

/** 进度面板：任务状态、用时、分阶段进度与中止入口 */
export function ProgressPanel({ task, events, onAbort, aborting = false }: ProgressPanelProps): React.JSX.Element | null {
	const running = task?.status === 'running';
	// 用时需要随运行实时跳动：每秒刷新一次「当前时间」，任务结束后停止
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);

	if (task === null) return <p className="hint">当前没有任务在运行。</p>;

	const duration = formatDuration((task.endedAt ?? now) - task.startedAt);
	const rows = collectPhases(events);
	const counts = countEdits(events);

	return (
		<section className="progress-panel">
			<div className="status-line">
				<span className={`status-badge status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
				<span className="task-label">{task.label}</span>
				<span className="duration">用时 {duration}</span>
				{running && (
					<button type="button" className="danger" onClick={onAbort} disabled={aborting}>
						{aborting ? '中止中…' : '中止'}
					</button>
				)}
			</div>
			{rows.length > 0 && (
				<div className="phases">
					{rows.map((row, index) => (
						<PhaseBar key={`${row.name}-${index}`} row={row} />
					))}
				</div>
			)}
			{(counts.changed > 0 || counts.skipped > 0 || counts.failed > 0) && (
				<p className="counts">
					修改 {counts.changed} · 跳过 {counts.skipped} · 失败 {counts.failed}
				</p>
			)}
		</section>
	);
}
