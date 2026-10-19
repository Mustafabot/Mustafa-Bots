// 文件还原页：看队列、看删除日志、挑着还原，跑完看逐条结果。
//
// 队列的正文由服务端读写（API 只收发条目），解析与生成在服务端的 queueFormat 里，
// 界面不碰 wikitext。跑任务时把勾选的文件名经 submitTitles 下发给脚本。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { LogView } from '../components/LogView';
import { ProgressPanel } from '../components/ProgressPanel';
import { useTaskRun } from '../hooks/useTaskRun';
import type { PageWriteResult, ProgressEvent, RestoreQueueState, StartTaskBody, TaskDescriptor } from '../types';

/** 一行在本次运行里的状态，按事件归并出来 */
interface RowState {
	log?: Record<string, string | number | null>;
	result?: string;
}

/** 从事件里归并逐条状态：detail 给删除日志，edit 给还原结果 */
function rowStatesFromEvents(events: ProgressEvent[]): Map<string, RowState> {
	const states = new Map<string, RowState>();
	for (const event of events) {
		if (event.type === 'detail') {
			const key = event.title.replace(/^File:/i, '');
			states.set(key, { ...states.get(key), log: event.fields });
		} else if (event.type === 'edit') {
			const key = event.title.replace(/^File:/i, '');
			const previous = states.get(key) ?? {};
			const label = event.status === 'changed'
				? (event.message?.startsWith('[DRY-RUN]') === true ? '空跑' : (event.message ?? '已还原'))
				: event.status === 'skipped' ? (event.message ?? '跳过') : `失败：${event.message ?? '未知原因'}`;
			states.set(key, { ...previous, result: label });
		}
	}
	return states;
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

	const loadQueue = useCallback(async (): Promise<void> => {
		try {
			const result = await api.restoreQueue.load();
			setQueue(result);
			setEntries(result.entries);
			setSelected(new Set(result.entries));
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
	const states = useMemo(() => rowStatesFromEvents(events), [events]);

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

	/** 只处理勾选的文件；一个都没勾时提示 */
	const selectedEntries = (): string[] => entries.filter((entry) => selected.has(entry));

	const startTask = async (values: Record<string, boolean>): Promise<void> => {
		if (descriptor === null) return;
		const chosen = selectedEntries();
		if (chosen.length === 0) {
			setNotice({ text: '先勾选要处理的文件。', kind: 'error' });
			return;
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

	const shownError = error;

	return (
		<section className="restore-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>文件还原</h2>
			</div>

			{shownError !== null && <p className="error">{shownError}</p>}
			{notice !== null && <p className={notice.kind === 'error' ? 'error' : 'hint'}>{notice.text}</p>}

			<ProgressPanel task={task} events={events} onAbort={() => void abort()} aborting={busy && running} />

			<div className="restore-actions">
				<button type="button" disabled={running || descriptor === null} onClick={() => void startTask({ '--dry-run': true })}>
					检查选中的
				</button>
				<button type="button" className="primary" disabled={running || descriptor === null} onClick={() => void startTask({})}>
					还原选中的 {selected.size} 个
				</button>
				<button type="button" disabled={running || queue === null} onClick={() => void saveQueue()}>
					保存队列
				</button>
				<p className="hint">队列页：{queue?.page ?? '…'}</p>
			</div>

			<ul className="restore-rows">
				{entries.map((entry) => {
					const key = entry.replace(/^File:/i, '');
					const state = states.get(key);
					return (
						<li className="restore-row" key={entry}>
							<input type="checkbox" checked={selected.has(entry)} disabled={running} onChange={(event) => toggle(entry, event.target.checked)} />
							<div className="restore-main">
								<div className="restore-line">
									<span className="restore-title">{entry}</span>
									{state?.result !== undefined && <span className="restore-result">{state.result}</span>}
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
