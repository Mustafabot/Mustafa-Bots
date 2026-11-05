// 任务列表页：把可选任务渲染成卡片，点进运行页。顺带提示当前是否有任务在跑。
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { Icon, type IconName } from '../components/Icon';
import type { TaskDescriptor, TaskRecord, TaskStatus } from '../types';

const STATUS_LABEL: Record<TaskStatus, string> = {
	running: '运行中',
	succeeded: '成功',
	failed: '失败',
	aborted: '已中止',
};

/** 已知任务配一个语义图标，其余用网格兜底 */
const TASK_ICON: Record<string, IconName> = {
	'text-replace': 'type',
	'auto-patrol': 'shield',
	'url-upload': 'upload',
	'file-restore': 'rotate',
	'link-replace': 'link',
};

/** 任务卡片列表 */
export function TaskList(): React.JSX.Element {
	const [descriptors, setDescriptors] = useState<TaskDescriptor[] | null>(null);
	const [task, setTask] = useState<TaskRecord | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		api.descriptors()
			.then((result) => {
				if (alive) setDescriptors(result.descriptors);
			})
			.catch((reason: unknown) => {
				if (alive) setError(reason instanceof ApiError ? reason.message : '无法加载任务列表');
			});
		api.task
			.get()
			.then((result) => {
				if (alive) setTask(result.task);
			})
			.catch(() => {
				// 拿不到当前任务不影响列表展示
			});
		return () => {
			alive = false;
		};
	}, []);

	const running = task?.status === 'running';

	return (
		<section className="task-list">
			{error !== null && <p className="error">{error}</p>}

			{task !== null && (
				<div className={`current-task ${task.status}`}>
					<span className="current-mark" aria-hidden="true">
						<Icon name={running ? 'activity' : 'clock'} size={20} />
					</span>
					<div className="current-copy">
						<p className="current-eyebrow">当前任务</p>
						<p className="current-label">
							{task.label}
							<span className={`current-status status-${task.status}`}>
								<span className="status-dot" aria-hidden="true" />
								{STATUS_LABEL[task.status]}
							</span>
						</p>
					</div>
					<a className="ghost-link" href={`#/task/${task.descriptorId}`}>
						查看运行
						<Icon name="arrowRight" size={15} />
					</a>
				</div>
			)}

			<div className="section-head">
				<h2>任务入口</h2>
				<span className="hint">{descriptors === null ? '正在加载…' : `${descriptors.length} 个任务 · 同时只运行一个`}</span>
			</div>

			<div className="cards">
				{descriptors === null && <p className="hint">加载中…</p>}
				{descriptors?.map((descriptor) => (
					// 有专属页的任务（文本替换、URL 上传）直达该页，其余走通用运行页
					<a className="card" key={descriptor.id} href={descriptor.page === undefined ? `#/task/${descriptor.id}` : `#/${descriptor.page}`}>
						<div className="card-top">
							<span className="card-icon">
								<Icon name={TASK_ICON[descriptor.id] ?? 'grid'} size={20} />
							</span>
							<h3>{descriptor.label}</h3>
						</div>
						<p className="entry">{descriptor.entry}</p>
						<div className="card-foot">
							<span className="card-meta">{descriptor.params.length > 0 ? `${descriptor.params.length} 个参数` : '无参数'}</span>
							<span className="card-go">
								打开
								<Icon name="arrowRight" size={14} />
							</span>
						</div>
					</a>
				))}
			</div>
		</section>
	);
}
