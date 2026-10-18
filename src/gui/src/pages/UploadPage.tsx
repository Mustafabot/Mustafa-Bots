// URL 上传页：填一批文件与共享的分类、前缀，上传到共享站并逐条看结果。
//
// 任务配置存本地草稿（api.uploadTasks），不写 wiki——条目里有本机文件的绝对路径。
// 跑任务时把表单内容随 rulesetContent 直接下发，不必先保存草稿。
// [检查线上状态] 走 --check（只查不传），[差分上传] 走 --only-missing。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { CategoryInput } from '../components/CategoryInput';
import { LogView } from '../components/LogView';
import { ProgressPanel } from '../components/ProgressPanel';
import { UploadFileList } from '../components/UploadFileList';
import { useTaskRun } from '../hooks/useTaskRun';
import { MAX_UPLOAD_BYTES } from '../licenseOptions';
import { decodeUploadTask, encodeUploadTask, makeRow, type UploadFormState, type UploadRow } from '../uploadTaskCodec';
import { outcomesFromEvents } from '../uploadOutcome';
import type { ParamValue, StartTaskBody, TaskDescriptor, UploadTaskSummary } from '../types';

/** 本次要跑的动作 */
type Action = 'check' | 'upload' | 'diff';

interface Notice {
	text: string;
	kind: 'info' | 'error';
}

const EMPTY_FORM: UploadFormState = { prefix: '', categories: [], comment: '', rows: [] };

export function UploadPage(): React.JSX.Element {
	const [descriptor, setDescriptor] = useState<TaskDescriptor | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [form, setForm] = useState<UploadFormState>(EMPTY_FORM);
	const [taskName, setTaskName] = useState('');
	const [tasks, setTasks] = useState<UploadTaskSummary[]>([]);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteText, setPasteText] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const { task, events, busy, error, start, abort } = useTaskRun();

	// 逐条结果由事件实时归并，跑的过程中就随事件更新
	const outcomes = useMemo(() => outcomesFromEvents(events), [events]);

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

	const refreshTasks = useCallback((): void => {
		api.uploadTasks
			.list()
			.then((result) => setTasks(result.tasks))
			.catch(() => {
				// 草稿列表拿不到不影响手动填
			});
	}, []);

	useEffect(() => {
		refreshTasks();
	}, [refreshTasks]);

	const running = task?.status === 'running';

	/** 把表单内容下发成一个任务 */
	const startAction = async (action: Action): Promise<void> => {
		if (descriptor === null) return;
		if (form.rows.length === 0) {
			setNotice({ text: '先加几个文件再跑。', kind: 'error' });
			return;
		}
		// 全量上传前提醒一次：脚本对同名文件是带 ignorewarnings 覆盖上传的，
		// 检查过、标着「已存在」的条目会被盖掉，得让这一步发生得明明白白。
		// 与脚本一致：脚本解析配置时会把前缀与文件名两端的空白去掉，这里也按去空白后的名字比
		if (action === 'upload') {
			const overwrite = form.rows.filter((row) => outcomes.get(`${form.prefix.trim()}${row.filename.trim()}`)?.online === '已存在').length;
			if (overwrite > 0 && !window.confirm(`有 ${overwrite} 条会覆盖线上已有的文件，确认继续？`)) return;
		}
		const values: Record<string, ParamValue> = {};
		if (action === 'check') values['--check'] = true;
		if (action === 'diff') values['--only-missing'] = true;
		const body: StartTaskBody = {
			descriptorId: descriptor.id,
			values,
			rulesetContent: encodeUploadTask(form),
			// 名字只当历史标签，没填就给一个能认出来的
			rulesetName: taskName.trim() === '' ? '未命名上传任务' : taskName.trim(),
		};
		setNotice(null);
		await start(body);
	};

	const saveDraft = async (): Promise<void> => {
		const name = taskName.trim();
		if (name === '') {
			setNotice({ text: '给这次任务起个名字才能保存。', kind: 'error' });
			return;
		}
		try {
			await api.uploadTasks.save(name, encodeUploadTask(form));
			refreshTasks();
			setNotice({ text: `已保存到本地草稿「${name}」。`, kind: 'info' });
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '保存草稿失败', kind: 'error' });
		}
	};

	const loadDraft = async (name: string): Promise<void> => {
		if (name === '') return;
		try {
			const result = await api.uploadTasks.read(name);
			if (result.task === null) {
				setNotice({ text: `本地草稿「${name}」不存在。`, kind: 'error' });
				return;
			}
			setTaskName(name);
			setForm(decodeUploadTask(result.task.content));
			// 换了一整份行（新 id），旧的选中 id 已经不存在，清掉免得「同步文件信息」点了只报错
			setSelectedId(null);
			setNotice({ text: `已载入草稿「${name}」。`, kind: 'info' });
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '载入草稿失败', kind: 'error' });
		}
	};

	/** 粘贴的一批地址：一行一个，逐行造行 */
	const addPastedUrls = (): void => {
		const rows = pasteText
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== '')
			.map((line) => makeRow({ url: line }));
		if (rows.length === 0) return;
		setForm((prev) => ({ ...prev, rows: [...prev.rows, ...rows] }));
		setPasteText('');
		setPasteOpen(false);
	};

	const fileInputRef = useRef<HTMLInputElement>(null);

	/**
	 * 把选中的本机文件交给服务端暂存，再把返回的**仓库相对路径**放进列表。
	 * 服务端按文件名存放，所以同名文件会互相覆盖——加之前先提醒一次，免得两张不同的图指向同一份字节。
	 * 前端先按大小拦一道：等服务端回 413 也要走一遍网络，不划算。
	 */
	const addLocalFiles = async (files: File[]): Promise<void> => {
		const accepted = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
		const rejected = files.filter((file) => file.size > MAX_UPLOAD_BYTES);
		if (rejected.length > 0) {
			setNotice({ text: `这些文件超过 20 MB，没有加进来：${rejected.map((file) => file.name).join('、')}`, kind: 'error' });
		}
		// 暂存目录按文件名存，同名会覆盖：已经在列表里的名字要先提醒
		const staged = new Set(form.rows.filter((row) => row.file !== '').map((row) => row.file.split('/').pop() ?? ''));
		const collisions = accepted.filter((file) => staged.has(file.name)).map((file) => file.name);
		if (collisions.length > 0 && !window.confirm(`这些文件名与列表里已有的本机文件相同，暂存会互相覆盖（两张图会指向同一份字节）：${collisions.join('、')}。仍要添加？`)) {
			return;
		}
		const rows: UploadRow[] = [];
		for (const file of accepted) {
			try {
				const uploaded = await api.uploads.put(file);
				rows.push(makeRow({ file: uploaded.path }));
			} catch (reason) {
				setNotice({ text: reason instanceof ApiError ? reason.message : `暂存 ${file.name} 失败`, kind: 'error' });
			}
		}
		if (rows.length > 0) setForm((prev) => ({ ...prev, rows: [...prev.rows, ...rows] }));
	};

	/** 同步文件信息：把选中那一行除来源与文件名以外的信息复制到全部行 */
	const syncSelectedInfo = (): void => {
		const source = form.rows.find((row) => row.id === selectedId);
		if (source === undefined) {
			setNotice({ text: '先点一下要作为模板的那一行。', kind: 'error' });
			return;
		}
		if (!window.confirm('把这一行的角色名、作者、源地址、授权协议复制到全部文件？')) return;
		setForm((prev) => ({
			...prev,
			rows: prev.rows.map((row) => ({ ...row, charaName: source.charaName, author: source.author, source: source.source, license: source.license })),
		}));
	};

	/** 清空服务端的暂存目录；先问一次，并把要删掉多少、占多大说清楚 */
	const clearUploads = async (): Promise<void> => {
		try {
			const listed = await api.uploads.list();
			if (listed.files.length === 0) {
				setNotice({ text: '暂存目录里没有文件。', kind: 'info' });
				return;
			}
			const sizeText = `${(listed.total / 1024 / 1024).toFixed(1)} MB`;
			if (!window.confirm(`将删除 ${listed.files.length} 个暂存文件（共 ${sizeText}）。已加进列表的本机文件路径会随之失效（可以重新拖进来）。继续？`)) return;
			const result = await api.uploads.clear();
			setNotice({ text: `已清理 ${result.removed} 个暂存文件（共 ${sizeText}）。`, kind: 'info' });
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '清理失败', kind: 'error' });
		}
	};

	const shownError = error ?? loadError;

	return (
		<section className="upload-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>URL 上传</h2>
			</div>
			{shownError !== null && <p className="error">{shownError}</p>}
			{notice !== null && <p className={notice.kind === 'error' ? 'error' : 'hint'}>{notice.text}</p>}

			<ProgressPanel task={task} events={events} onAbort={() => void abort()} aborting={busy && running} />

			<div className="upload-shared">
				<label className="field">
					<span>前缀</span>
					<input type="text" value={form.prefix} disabled={running} placeholder="拼在每个目标文件名前面" onChange={(event) => setForm((prev) => ({ ...prev, prefix: event.target.value }))} />
				</label>
				<CategoryInput categories={form.categories} disabled={running} onChange={(categories) => setForm((prev) => ({ ...prev, categories }))} />
				<label className="field">
					<span>上传摘要</span>
					<input type="text" value={form.comment} disabled={running} placeholder="留空则按协议、人物、作者、源地址、分类自动拼" onChange={(event) => setForm((prev) => ({ ...prev, comment: event.target.value }))} />
				</label>
			</div>

			<div
				className="upload-drop"
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					void addLocalFiles([...event.dataTransfer.files]);
				}}
			>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*,.svg,.pdf"
					multiple
					style={{ display: 'none' }}
					onChange={(event) => {
						void addLocalFiles([...(event.target.files ?? [])]);
						event.target.value = '';
					}}
				/>
				<button type="button" disabled={running} onClick={() => fileInputRef.current?.click()}>
					添加本机文件
				</button>
				<span className="hint">也可以把文件拖到这里（单个不超过 20 MB）</span>
			</div>

			<div className="upload-actions">
				<button type="button" disabled={descriptor === null || running || form.rows.length === 0} onClick={() => void startAction('check')}>
					检查线上状态
				</button>
				<button type="button" className="primary" disabled={descriptor === null || running || form.rows.length === 0} onClick={() => void startAction('upload')}>
					上传
				</button>
				<button type="button" disabled={descriptor === null || running || form.rows.length === 0} onClick={() => void startAction('diff')}>
					差分上传
				</button>
				<button type="button" disabled={running || selectedId === null} onClick={syncSelectedInfo}>
					同步文件信息
				</button>
				<button type="button" onClick={() => setPasteOpen((open) => !open)}>
					粘贴一批地址
				</button>
			</div>

			{pasteOpen && (
				<div className="upload-paste">
					<textarea value={pasteText} rows={6} placeholder="一行一个图片地址" onChange={(event) => setPasteText(event.target.value)} />
					<button type="button" onClick={addPastedUrls}>
						加进列表
					</button>
				</div>
			)}

			<UploadFileList
				rows={form.rows}
				outcomes={outcomes}
				prefix={form.prefix}
				selectedId={selectedId}
				onSelect={setSelectedId}
				onChange={(rows: UploadRow[]) => setForm((prev) => ({ ...prev, rows }))}
				disabled={running}
			/>

			<div className="upload-drafts">
				<label className="field">
					<span>任务名</span>
					<input type="text" value={taskName} disabled={running} placeholder="起个名字才能保存到本地草稿" onChange={(event) => setTaskName(event.target.value)} />
				</label>
				<button type="button" disabled={running} onClick={() => void saveDraft()}>
					保存草稿
				</button>
				<select value="" disabled={running} onChange={(event) => void loadDraft(event.target.value)}>
					<option value="">— 载入草稿 —</option>
					{tasks.map((item) => (
						<option key={item.name} value={item.name}>
							{item.name}
						</option>
					))}
				</select>
				<p className="hint">草稿存在本地（data/gui/upload-tasks/），不上传任何 wiki 页面；跑任务不必先保存。</p>
			</div>

			<div className="upload-drafts">
				<button type="button" disabled={running} onClick={() => void clearUploads()}>
					清理临时文件
				</button>
				<p className="hint">删掉服务端暂存的本机文件（data/gui/uploads/）。不自动清理，因为清单里的路径还指着它们。</p>
			</div>

			<LogView events={events} />
		</section>
	);
}
