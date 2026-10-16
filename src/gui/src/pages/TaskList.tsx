// 任务列表页：把可选任务渲染成卡片，点进运行页。顺带提示当前是否有任务在跑。
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { TaskDescriptor, TaskRecord, TaskStatus } from '../types';

const STATUS_LABEL: Record<TaskStatus, string> = {
	running: '运行中',
	succeeded: '成功',
	failed: '失败',
	aborted: '已中止',
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

	return (
		<section className="task-list">
			{error !== null && <p className="error">{error}</p>}
			{task !== null && (
				<p className={`current-task ${task.status === 'running' ? 'running' : ''}`}>
					当前任务：{task.label}（{STATUS_LABEL[task.status]}）
					<a href={`#/task/${task.descriptorId}`}>查看</a>
				</p>
			)}
			<div className="cards">
				{descriptors === null && <p className="hint">加载中…</p>}
				{descriptors?.map((descriptor) => (
					<a className="card" key={descriptor.id} href={`#/task/${descriptor.id}`}>
						<h3>{descriptor.label}</h3>
						<p className="entry">{descriptor.entry}</p>
						<p className="hint">{descriptor.params.length > 0 ? `${descriptor.params.length} 个参数` : '无参数'}</p>
					</a>
				))}
			</div>
		</section>
	);
}
