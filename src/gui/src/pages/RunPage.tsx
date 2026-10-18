// 通用任务运行页：选一个任务、填参数、开始/中止，并实时看进度与日志。
// 任务编排（SSE + 启动/中止）走 useTaskRun，与文本替换页共用一份。
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { LogView } from '../components/LogView';
import { ParamForm } from '../components/ParamForm';
import { ProgressPanel } from '../components/ProgressPanel';
import { useTaskRun } from '../hooks/useTaskRun';
import type { ParamValue, TaskDescriptor } from '../types';

/** 按描述符的默认值初始化表单值；键与 POST /api/task 的 values 一致 */
function initialValues(descriptor: TaskDescriptor): Record<string, ParamValue> {
	const values: Record<string, ParamValue> = {};
	for (const spec of descriptor.params) {
		if (spec.kind === 'positional') values[spec.name] = '';
		else if (spec.kind === 'boolean') values[spec.flag] = spec.default ?? false;
		else if (spec.kind === 'number') values[spec.flag] = spec.default ?? '';
		else if (spec.kind === 'stringList') values[spec.flag] = spec.default ?? [];
		else values[spec.flag] = spec.default ?? '';
	}
	return values;
}

/** 任务运行页；只做通用表单页，文本替换页与历史页是各自独立的页面 */
export function RunPage({ id }: { id: string }): React.JSX.Element {
	const [descriptors, setDescriptors] = useState<TaskDescriptor[] | null>(null);
	const [values, setValues] = useState<Record<string, ParamValue>>({});
	const [loadError, setLoadError] = useState<string | null>(null);
	const { task, events, busy, error, start, abort } = useTaskRun();

	useEffect(() => {
		let alive = true;
		api.descriptors()
			.then((result) => {
				if (alive) setDescriptors(result.descriptors);
			})
			.catch((reason: unknown) => {
				if (alive) setLoadError(reason instanceof ApiError ? reason.message : '无法加载任务列表');
			});
		return () => {
			alive = false;
		};
	}, []);

	const descriptor = useMemo(() => descriptors?.find((item) => item.id === id) ?? null, [descriptors, id]);

	// 描述符就绪后按默认值填一次表单
	useEffect(() => {
		if (descriptor) setValues(initialValues(descriptor));
	}, [descriptor]);

	const running = task?.status === 'running';
	// 带规则集参数的任务（文本替换）需要先选规则集，其选择界面在「文本替换」页
	const needsRuleset = descriptor?.configFileFlag !== undefined;
	const shownError = error ?? loadError;

	const onStart = (): void => {
		if (!descriptor) return;
		void start({ descriptorId: descriptor.id, values });
	};

	return (
		<section className="run-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>{descriptor?.label ?? '任务'}</h2>
			</div>

			{shownError !== null && <p className="error">{shownError}</p>}
			{descriptors !== null && descriptor === null && <p className="error">未知任务：{id}</p>}

			{descriptor !== null && (
				<>
					<ProgressPanel task={task} events={events} onAbort={() => void abort()} aborting={busy && running} />

					<div className="run-controls">
						{running && <p className="hint">任务运行中，参数已锁定。点上方「中止」可停止。</p>}
						<ParamForm spec={descriptor} values={values} onChange={setValues} disabled={running} />
						{needsRuleset && !running && (
							<p className="hint">
								该任务需要先选规则集，请到 <a href="#/text-replace">文本替换</a> 页操作。
							</p>
						)}
						{!running && (
							<button type="button" className="primary start" onClick={onStart} disabled={busy || needsRuleset}>
								{busy ? '启动中…' : '开始'}
							</button>
						)}
					</div>

					<LogView events={events} />
				</>
			)}
		</section>
	);
}
