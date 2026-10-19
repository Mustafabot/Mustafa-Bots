// 文件还原页：看队列、看删除日志、挑着还原，跑完看逐条结果。
//
// 队列的正文由服务端读写（API 只收发条目），解析与生成在服务端的 queueFormat 里，
// 界面不碰 wikitext。跑任务时把勾选的文件名经 submitTitles 下发给脚本。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { LogView } from '../components/LogView';
import { ProgressPanel } from '../components/ProgressPanel';
import { useTaskRun } from '../hooks/useTaskRun';
import { restoreOutcomesFromEvents } from '../restoreOutcome';
import type { PageWriteResult, RestoreQueueState, StartTaskBody, TaskDescriptor } from '../types';

/** 事件与队列都以 `File:xxx` 记文件名，界面用去掉前缀的键互相对上 */
function entryKey(name: string): string {
	return name.replace(/^File:/i, '');
}

/** 文件还原页 */
export function FileRestorePage(): React.JSX.Element {
	const [descriptor, setDescriptor] = useState<TaskDescriptor | null>(null);
	const [queue, setQueue] = useState<RestoreQueueState | null>(null);
	const [entries, setEntries] = useState<string[]>([]);
	const [draftEntry, setDraftEntry] = useState('');
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
	const [conflict, setConflict] = useState<{ remote: string | null; reason: string } | null>(null);

	// 上一次列表里的条目：重载时据它区分"早先就在的行"（保留勾选）与"新出现的行"（默认勾上）
	const previousEntries = useRef<string[]>([]);
	useEffect(() => {
		previousEntries.current = entries;
	}, [entries]);

	const loadQueue = useCallback(async (): Promise<void> => {
		try {
			const result = await api.restoreQueue.load();
			// 只认前一次列表：首次载入时它是空的，于是整队默认勾上；之后的重载保留用户在界面上的增删勾选
			const known = new Set(previousEntries.current);
			setQueue(result);
			setEntries(result.entries);
			setSelected((prev) => {
				const next = new Set<string>();
				for (const entry of result.entries) {
					// 早先就在的行沿用此前的勾选状态，新出现的行默认勾上
					if (!known.has(entry) || prev.has(entry)) next.add(entry);
				}
				return next;
			});
			setConflict(null);
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '读取队列失败', kind: 'error' });
		}
	}, []);

	const { task, events, busy, error, start, abort } = useTaskRun(() => {
		// 任务结束时队列可能已被脚本改过，重新读一次
		void loadQueue();
	});

	const running = task?.status === 'running';
	const states = useMemo(() => restoreOutcomesFromEvents(events), [events]);

	useEffect(() => {
		void loadQueue();
	}, [loadQueue]);

	useEffect(() => {
		let alive = true;
		api.descriptors()
			.then((result) => {
				if (alive) setDescriptor(result.descriptors.find((item) => item.id === 'file-restore') ?? null);
			})
			.catch(() => {
				// 登录门已在 App 处理
			});
		return () => {
			alive = false;
		};
	}, []);

	/** 检查/还原报过"不可还原"的行：标灰、不勾选、不计数、不进工作清单 */
	const isRestorable = useCallback((entry: string): boolean => states.get(entryKey(entry))?.restorable !== false, [states]);

	/** 只处理勾选且可还原的文件；一个都没有时后续动作提示 */
	const chosenEntries = (): string[] => entries.filter((entry) => selected.has(entry) && isRestorable(entry));
	const chosenCount = entries.filter((entry) => selected.has(entry) && isRestorable(entry)).length;

	const startTask = async (values: Record<string, boolean>): Promise<void> => {
		if (descriptor === null) return;
		const chosen = chosenEntries();
		if (chosen.length === 0) {
			setNotice({ text: '先勾选要处理的文件。', kind: 'error' });
			return;
		}
		// 真任务：本地新加、尚未写回队列的行跑完就不在队列里了，动手前先说清楚（空跑不改动队列，不必问）
		if (values['--dry-run'] !== true) {
			const onServer = new Set(queue?.entries ?? []);
			const unsaved = chosen.filter((entry) => !onServer.has(entry));
			if (unsaved.length > 0 && !window.confirm(`有 ${unsaved.length} 个选中的条目不在队列里（本地新增、尚未保存）。它们会被处理，但处理后不会留在队列里。仍要继续吗？`)) {
				return;
			}
		}
		const body: StartTaskBody = { descriptorId: descriptor.id, values, rulesetName: '文件还原', submitTitles: chosen };
		setNotice(null);
		await start(body);
	};

	const saveQueue = async (force = false): Promise<void> => {
		if (queue === null) return;
		try {
			await api.restoreQueue.save(entries, queue.revid, force);
			setConflict(null);
			setNotice({ text: '队列已保存。', kind: 'info' });
			await loadQueue();
		} catch (reason) {
			// 冲突以 409 返回：`request` 统一把非 2xx 抛成 ApiError，冲突详情在 body 里
			const body = reason instanceof ApiError ? reason.body : null;
			if (body !== null && (body as { ok?: unknown }).ok === false) {
				const failed = body as unknown as Extract<PageWriteResult, { ok: false }>;
				setConflict({ remote: failed.remote, reason: failed.reason });
				return;
			}
			setNotice({ text: reason instanceof ApiError ? reason.message : '保存队列失败', kind: 'error' });
		}
	};

	const addEntry = (): void => {
		const name = draftEntry.trim();
		if (name === '') return;
		if (entries.includes(name)) {
			setNotice({ text: '这一条已经在队列里了。', kind: 'error' });
			return;
		}
		setEntries([...entries, name]);
		setSelected(new Set([...selected, name]));
		setDraftEntry('');
	};

	const removeEntry = (name: string): void => {
		setEntries(entries.filter((entry) => entry !== name));
		const next = new Set(selected);
		next.delete(name);
		setSelected(next);
	};

	const toggle = (name: string, checked: boolean): void => {
		const next = new Set(selected);
		if (checked) next.add(name);
		else next.delete(name);
		setSelected(next);
	};

	return (
		<section className="restore-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>文件还原</h2>
			</div>

			{error !== null && <p className="error">{error}</p>}
			{notice !== null && <p className={notice.kind === 'error' ? 'error' : 'hint'}>{notice.text}</p>}

			<ProgressPanel task={task} events={events} onAbort={() => void abort()} aborting={busy && running} />

			<div className="restore-actions">
				<button type="button" disabled={running || descriptor === null} onClick={() => void startTask({ '--dry-run': true })}>
					检查选中的
				</button>
				<button type="button" className="primary" disabled={running || descriptor === null} onClick={() => void startTask({})}>
					还原选中的 {chosenCount} 个
				</button>
				<button type="button" disabled={running || queue === null} onClick={() => void saveQueue()}>
					保存队列
				</button>
				<p className="hint">队列页：{queue?.page ?? '…'}</p>
			</div>

			<ul className="restore-rows">
				{entries.map((entry) => {
					const state = states.get(entryKey(entry));
					const restorable = state?.restorable !== false;
					return (
						<li className={restorable ? 'restore-row' : 'restore-row restore-row-muted'} key={entry}>
							<input type="checkbox" checked={restorable && selected.has(entry)} disabled={running || !restorable} onChange={(event) => toggle(entry, event.target.checked)} />
							<div className="restore-main">
								<div className="restore-line">
									<span className="restore-title">{entry}</span>
									{state?.result !== undefined && <span className="restore-result">{state.result}</span>}
									{!restorable && <span className="hint">不可还原</span>}
								</div>
								{state?.log !== undefined && (
									<div className="restore-log">
										{Object.entries(state.log).map(([label, value]) => (
											<span key={label}>
												{label}：{value === null ? '（无）' : value}
											</span>
										))}
									</div>
								)}
							</div>
							<button type="button" className="restore-remove" disabled={running} onClick={() => removeEntry(entry)}>
								删除
							</button>
						</li>
					);
				})}
			</ul>

			<div className="restore-add">
				<input type="text" value={draftEntry} disabled={running} placeholder="File:文件名（一行一个）" onChange={(event) => setDraftEntry(event.target.value)} onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						addEntry();
					}
				}} />
				<button type="button" disabled={running} onClick={addEntry}>
					添加
				</button>
			</div>

			{conflict !== null && (
				<div className="restore-conflict">
					<p className="error">
						队列页在编辑期间被改过（{conflict.reason === 'missing' ? '线上已不存在' : '版本不一致'}），草稿没有写回。
					</p>
					<details>
						<summary>查看线上当前内容</summary>
						<pre>{conflict.remote ?? '（线上没有内容）'}</pre>
					</details>
					<button type="button" onClick={() => void saveQueue(true)}>
						以线上当前版本为基线覆盖
					</button>
					<button type="button" onClick={() => void loadQueue()}>
						丢弃本地改动，重新载入
					</button>
				</div>
			)}

			<LogView events={events} />
		</section>
	);
}
