// 通用任务运行页：选一个任务、填参数、开始/中止，并实时看进度与日志。
// 任务状态存在服务端，关掉页面再回来（或刷新）都能从 api.task.get() + SSE 回放里恢复。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { LogView } from '../components/LogView';
import { ParamForm } from '../components/ParamForm';
import { ProgressPanel } from '../components/ProgressPanel';
import { subscribeTaskEvents } from '../sse';
import type { ParamValue, ProgressEvent, TaskDescriptor, TaskRecord } from '../types';

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

/** 任务运行页；只做这一个页面，文本替换页与历史页留给后续任务 */
export function RunPage({ id }: { id: string }): React.JSX.Element {
	const [descriptors, setDescriptors] = useState<TaskDescriptor[] | null>(null);
	const [task, setTask] = useState<TaskRecord | null>(null);
	const [events, setEvents] = useState<ProgressEvent[]>([]);
	const [values, setValues] = useState<Record<string, ParamValue>>({});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// 记住当前事件属于哪个任务：换了任务就重置事件数组，避免上一个任务的日志混进新任务
	const taskIdRef = useRef<string | null>(null);

	// 进页面先取描述符与当前任务（任务状态在服务端，刷新后仍在）
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
					setEvents((prev) => (isNewTask ? [frame.event] : [...prev, frame.event]));
					setTask({ ...frame.task, events: [] });
				},
				(status) => {
					// 每次（重）连上都会重放完整事件，先清空以免重连后重复
					if (status === 'open') setEvents([]);
				},
			),
		[],
	);

	const descriptor = useMemo(() => descriptors?.find((item) => item.id === id) ?? null, [descriptors, id]);

	// 描述符就绪后按默认值填一次表单
	useEffect(() => {
		if (descriptor) setValues(initialValues(descriptor));
	}, [descriptor]);

	const running = task?.status === 'running';
	// 带规则集参数的任务（文本替换）需要先选规则集，其选择界面属后续任务，这里先不放行
	const needsRuleset = descriptor?.rulesetFlag !== undefined;

	const start = (): void => {
		if (!descriptor) return;
		setBusy(true);
		setError(null);
		api.task
			.start({ descriptorId: descriptor.id, values })
			.then((result) => setTask(result.task))
			.catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : '启动任务失败'))
			.finally(() => setBusy(false));
	};

	const abort = (): void => {
		setBusy(true);
		setError(null);
		api.task
			.abort()
			.catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : '中止任务失败'))
			.finally(() => setBusy(false));
	};

	return (
		<section className="run-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>{descriptor?.label ?? '任务'}</h2>
			</div>

			{error !== null && <p className="error">{error}</p>}
			{descriptors !== null && descriptor === null && <p className="error">未知任务：{id}</p>}

			{descriptor !== null && (
				<>
					<ProgressPanel task={task} events={events} onAbort={abort} aborting={busy && running} />

					<div className="run-controls">
						{running && <p className="hint">任务运行中，参数已锁定。点上方「中止」可停止。</p>}
						<ParamForm spec={descriptor} values={values} onChange={setValues} disabled={running} />
						{needsRuleset && !running && <p className="hint">该任务需要先在「全站文本替换」页选择规则集。</p>}
						{!running && (
							<button type="button" className="primary start" onClick={start} disabled={busy || needsRuleset}>
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
