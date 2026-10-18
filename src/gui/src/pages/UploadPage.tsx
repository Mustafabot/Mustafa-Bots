// URL 上传页：填一批文件与共享的分类、前缀，上传到共享站并逐条看结果。
// 任务配置存本地草稿，不写 wiki——条目里有本机文件的绝对路径。
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { ProgressPanel } from '../components/ProgressPanel';
import { useTaskRun } from '../hooks/useTaskRun';
import type { TaskDescriptor } from '../types';

export function UploadPage(): React.JSX.Element {
	const [descriptor, setDescriptor] = useState<TaskDescriptor | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const { task, events, busy, abort } = useTaskRun();

	useEffect(() => {
		let alive = true;
		api.descriptors()
			.then((result) => {
				if (alive) setDescriptor(result.descriptors.find((item) => item.id === 'url-upload') ?? null);
			})
			.catch((reason: unknown) => {
				if (alive) setLoadError(reason instanceof ApiError ? reason.message : '无法加载任务列表');
			});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<section className="upload-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>URL 上传</h2>
			</div>
			{loadError !== null && <p className="error">{loadError}</p>}
			{descriptor === null && loadError === null && <p className="hint">加载中…</p>}
			<ProgressPanel task={task} events={events} onAbort={() => void abort()} aborting={busy} />
		</section>
	);
}
