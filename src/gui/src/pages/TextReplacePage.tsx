// 全站文本替换页：填规则 → 扫描看命中 → 勾选提交。
//
// 流程（规格）：
//   站点下拉 → 规则表单（一行一条，只留正则勾选）→ 页面/分类清单 → 命名空间复选框
//   → [扫描] [空跑] → 命中结果（内联展开匹配行）→ [提交选中的 N 页]
//
// 清单模式可以不扫描：文本里一行一个页面，分类行带 分类:/Category:/Cat: 前缀，
// [空跑清单]/[替换清单] 由脚本展开分类后逐页重取最新内容替换（不读镜像）。
// 结果只给顶部汇总与日志，不再逐页生成结果卡片。
//
// [扫描] 只搜不改（`--scan-only --no-sync`），结果落盘后按 resultFile 取命中；
// [空跑] 按规则真跑一遍但不提交（`--dry-run`），已勾选的页面只空跑这些；
// [提交] 走 `submitTitles`，只改勾中的页面。
// 规则随任务直接下发（rulesetContent），不必先存预设；预设只为复用与发布。
// 结果刷新只发生在点「扫描」时，规则调整不做自动重扫。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { HitList } from '../components/HitList';
import { LogView } from '../components/LogView';
import { NamespacePicker } from '../components/NamespacePicker';
import { PresetPicker } from '../components/PresetPicker';
import { ProgressPanel } from '../components/ProgressPanel';
import { RuleEditor } from '../components/RuleEditor';
import { useTaskRun, type TaskDoneInfo } from '../hooks/useTaskRun';
import { decodeRuleset, encodeRuleset, type RuleFormState } from '../rulesetCodec';
import { configPageFor } from '../rulesetNaming';
import type { NamespaceList, ParamValue, RulesetSummary, ScanPageHit, ScanResultMeta, StartTaskBody, TaskDescriptor } from '../types';

/** 命中结果每页取多少条（服务端单次上限 1000，这里取个小批量便于增量加载） */
const PAGE_SIZE = 200;

/** 本次要跑的动作：决定 values 与完成后的处理 */
type Action = 'scan' | 'dryrun' | 'submit' | 'sync' | 'targets' | 'targets-dry';

/** 页面级状态提示 */
interface Notice {
	text: string;
	kind: 'info' | 'error';
}

/** done 摘要里常见键的中文标签 */
const SUMMARY_LABEL: Record<string, string> = {
	changed: '修改',
	staleSkipped: '已无匹配',
	failed: '失败',
	hits: '命中',
	scanned: '扫描',
};

function describeSummary(summary: Record<string, number>): string {
	const parts = Object.entries(summary)
		.filter(([, value]) => value !== 0 || Object.keys(summary).length === 1)
		.map(([key, value]) => `${SUMMARY_LABEL[key] ?? key} ${value}`);
	return parts.length > 0 ? parts.join('，') : '无变化';
}

/** 发布冲突时给用户看的文案；远端正文另外用 <details> 展开 */
function publishConflictText(reason: 'conflict' | 'missing'): string {
	if (reason === 'missing') return '线上配置页当前不存在（可能已被删除），草稿记的版本已失效。确认后点「以线上当前版本为基线覆盖」会重新建立基线并新建该页。';
	return '线上配置页已被他人改动，草稿基于旧版本，无法直接覆盖。请先比对下方线上内容，确认后再点「以线上当前版本为基线覆盖」。';
}

/** 由扫描结果元信息拼出结果文件名（与服务端 scanFileName 规则一致：站名 + 指纹前 12 位） */
function scanFileNameOf(meta: ScanResultMeta): string {
	return `scan_${meta.wiki}_${meta.fingerprint.slice(0, 12)}.json`;
}

/** 全站文本替换页 */
export function TextReplacePage(): React.JSX.Element {
	const [descriptor, setDescriptor] = useState<TaskDescriptor | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [wiki, setWiki] = useState<'zh' | 'cm'>('zh');
	const [nsList, setNsList] = useState<NamespaceList | null>(null);
	const [form, setForm] = useState<RuleFormState>({ rules: [{ from: '', to: '', regex: false, ignoreCase: false }], namespaces: [] });
	const [presets, setPresets] = useState<RulesetSummary[]>([]);
	const [presetName, setPresetName] = useState('');
	// 目标配置页：空串表示"按预设名推出默认页"，输入框里显示的就是推出的结果
	const [configPage, setConfigPage] = useState('');
	const [notice, setNotice] = useState<Notice | null>(null);
	const [conflictRemote, setConflictRemote] = useState<string | null>(null);
	const [scanName, setScanName] = useState<string | null>(null);
	// 当前站点最近一次落盘的扫描结果（列表里按 createdAt 取最新），以及刷新后才收到 done 回放时的结果文件名
	const [latestScan, setLatestScan] = useState<ScanResultMeta | null>(null);
	const [recoveredScan, setRecoveredScan] = useState<string | null>(null);
	const [hits, setHits] = useState<ScanPageHit[]>([]);
	const [hitTotal, setHitTotal] = useState(0);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// 页面/分类清单原文：一行一个，分类行带 分类:/Category:/Cat: 前缀
	const [targetList, setTargetList] = useState('');
	const [loadingMore, setLoadingMore] = useState(false);
	const [fetchingNs, setFetchingNs] = useState(false);
	// 记录本次启动的是哪个动作：done 回调据此决定做什么
	const pendingRef = useRef<Action | null>(null);

	// 任务编排（SSE + 启动/中止 + 状态）与运行页共用一份
	const { task, events, busy, error, start, abort } = useTaskRun((info) => onDone(info));

	// 取描述符（规则集参数开关等由它决定）
	useEffect(() => {
		let alive = true;
		api.descriptors()
			.then((result) => {
				if (alive) setDescriptor(result.descriptors.find((item) => item.id === 'text-replace') ?? null);
			})
			.catch((reason: unknown) => {
				if (alive) setLoadError(reason instanceof ApiError ? reason.message : '无法加载任务列表');
			});
		return () => {
			alive = false;
		};
	}, []);

	const refreshPresets = useCallback((): void => {
		api.rulesets
			.list()
			.then((result) => setPresets(result.rulesets))
			.catch(() => {
				// 预设列表拿不到不影响手动填名字
			});
	}, []);

	useEffect(() => {
		refreshPresets();
	}, [refreshPresets]);

	// 站点变化时重新拉命名空间，并把勾选重置为该站镜像已覆盖的范围
	useEffect(() => {
		let alive = true;
		api.namespaces(wiki)
			.then((list) => {
				if (!alive) return;
				setNsList(list);
				setForm((prev) => ({ ...prev, namespaces: list.mirrorNamespaces }));
			})
			.catch((reason: unknown) => {
				if (alive) setNotice({ text: reason instanceof ApiError ? reason.message : '无法加载命名空间', kind: 'error' });
			});
		return () => {
			alive = false;
		};
	}, [wiki]);

	// 载入最近一次扫描结果用：当前站点按 createdAt 取最新的那条（刷新页面后靠它取回，不必重扫）
	useEffect(() => {
		let alive = true;
		api.scans
			.list()
			.then((result) => {
				if (!alive) return;
				const latest = result.scans.filter((scan) => scan.wiki === wiki).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
				setLatestScan(latest);
			})
			.catch(() => {
				// 结果列表拿不到不影响手动扫描
			});
		return () => {
			alive = false;
		};
	}, [wiki]);

	const refreshNamespaces = useCallback((): void => {
		api.namespaces(wiki)
			.then(setNsList)
			.catch(() => {
				// 同步完成后刷新失败就沿用旧清单，用户可手动重试
			});
	}, [wiki]);

	/** 取扫描结果并载入第一页命中 */
	const loadScanResult = useCallback(async (name: string): Promise<void> => {
		setScanName(name);
		try {
			const slice = await api.scans.page(name, 0, PAGE_SIZE);
			setHits(slice.hits);
			setHitTotal(slice.total);
			setSelected(new Set(slice.hits.map((hit) => hit.title)));
			setNotice({ text: `扫描完成：命中 ${slice.total} 页。`, kind: 'info' });
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '读取扫描结果失败', kind: 'error' });
		}
	}, []);

	// done 回调：hook 里靠 ref 保证读到最新闭包
	const onDone = (info: TaskDoneInfo): void => {
		const action = pendingRef.current;
		pendingRef.current = null;
		if (action === 'scan') {
			if (info.resultFile === undefined) {
				setNotice({ text: '扫描完成，但没有拿到结果文件。', kind: 'error' });
				return;
			}
			void loadScanResult(info.resultFile);
		} else if (action === 'submit') {
			setNotice({ text: `提交完成：${describeSummary(info.summary)}。`, kind: 'info' });
		} else if (action === 'targets' || action === 'targets-dry') {
			setNotice({ text: `清单替换完成：${describeSummary(info.summary)}。`, kind: 'info' });
		} else if (action === 'dryrun') {
			setNotice({ text: '空跑完成，未提交任何编辑（日志中带 [DRY-RUN] 的行即"将会修改"）。', kind: 'info' });
		} else if (action === 'sync') {
			setFetchingNs(false);
			setNotice({ text: '镜像同步完成，现在可以扫描了。', kind: 'info' });
			refreshNamespaces();
		} else if (info.resultFile !== undefined) {
			// 刷新页面后才收到 done 回放：pendingRef 已清空，判不出本次动作，
			// 但结果确实落了盘，给一个可载入的入口（不自动载入，免得打断用户当前操作）
			setRecoveredScan(info.resultFile);
		}
	};

	/** 启动一个动作：按动作拼 values，交给 hook */
	const startAction = async (action: Action, addNamespace?: number): Promise<void> => {
		if (descriptor === null) return;
		const values: Record<string, ParamValue> = { '--wiki': wiki };
		const body: StartTaskBody = { descriptorId: descriptor.id, values };

		if (action === 'sync') {
			// 抓取/同步镜像不读规则集（--sync-only 下脚本不构建也不校验规则），
			// 因此不带规则、不落草稿：用户往往在配规则之前就要先把镜像弄热
			values['--sync-only'] = true;
			if (addNamespace !== undefined) values['--add-namespaces'] = [String(addNamespace)];
		} else if (action === 'targets' || action === 'targets-dry') {
			// 清单模式逐页重取最新内容，不读镜像；规则照常下发，命名空间只用于断点指纹
			const cleanedRules = form.rules.filter((rule) => rule.from !== '');
			if (cleanedRules.length === 0) {
				setNotice({ text: '请至少填一条规则（「从」不能为空）。', kind: 'error' });
				return;
			}
			const text = targetList.trim();
			if (text === '') {
				setNotice({ text: '请先填页面/分类清单（一行一个）。', kind: 'error' });
				return;
			}
			values['--namespace'] = form.namespaces.map((ns) => String(ns));
			if (action === 'targets-dry') values['--dry-run'] = true;
			body.rulesetContent = encodeRuleset({ ...form, rules: cleanedRules });
			const label = configPage.trim() !== '' ? configPage.trim() : presetName.trim();
			if (label !== '') body.rulesetName = label;
			body.targets = text;
		} else {
			// 空规则行没意义，先滤掉
			const cleanedRules = form.rules.filter((rule) => rule.from !== '');
			if (cleanedRules.length === 0) {
				setNotice({ text: '请至少填一条规则（「从」不能为空）。', kind: 'error' });
				return;
			}
			values['--no-sync'] = true;
			values['--namespace'] = form.namespaces.map((ns) => String(ns));
			if (action === 'scan') values['--scan-only'] = true;
			if (action === 'dryrun') values['--dry-run'] = true;
			// 规则随任务直接下发，不逼用户先存预设；名字只当历史标签，没有就不传
			body.rulesetContent = encodeRuleset({ ...form, rules: cleanedRules });
			const label = configPage.trim() !== '' ? configPage.trim() : presetName.trim();
			if (label !== '') body.rulesetName = label;
			// 提交与空跑都按勾选的页面走；没勾选时空跑退化为全命名空间试跑
			const titles = [...selected];
			if ((action === 'submit' || action === 'dryrun') && titles.length > 0) body.submitTitles = titles;
		}

		pendingRef.current = action;
		setNotice(null);
		setConflictRemote(null);
		if (action === 'sync') setFetchingNs(true);
		const started = await start(body);
		if (started === null) {
			pendingRef.current = null;
			if (action === 'sync') setFetchingNs(false);
		}
	};

	const loadMore = async (): Promise<void> => {
		if (scanName === null) return;
		setLoadingMore(true);
		try {
			const slice = await api.scans.page(scanName, hits.length, PAGE_SIZE);
			setHits((prev) => [...prev, ...slice.hits]);
			setHitTotal(slice.total);
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '加载更多失败', kind: 'error' });
		} finally {
			setLoadingMore(false);
		}
	};

	const loadPreset = async (name: string): Promise<void> => {
		try {
			const { draft, remote } = await api.rulesets.read(name);
			const content = draft?.content ?? remote.content;
			if (content === null || content === undefined) {
				setNotice({ text: `预设「${name}」没有内容。`, kind: 'error' });
				return;
			}
			setForm(decodeRuleset(content));
			// 只在草稿的目标页不是"按名字推的默认页"时才回填：否则改成预设名时页会跟不动
			const page = draft?.page ?? '';
			setConfigPage(page !== '' && page !== configPageFor(name) ? page : '');
			setNotice({ text: `已载入预设「${name}」。`, kind: 'info' });
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '载入预设失败', kind: 'error' });
		}
	};

	/** 目标配置页：填了用自己的，没填按预设名推出默认页 */
	const targetPage = (): string => (configPage.trim() !== '' ? configPage.trim() : configPageFor(presetName));

	const savePreset = async (name: string): Promise<void> => {
		try {
			await api.rulesets.save(name, encodeRuleset({ ...form, rules: form.rules.filter((rule) => rule.from !== '') }), targetPage());
			setNotice({ text: `已保存预设「${name}」（草稿）。`, kind: 'info' });
			refreshPresets();
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '保存预设失败', kind: 'error' });
		}
	};

	/** 发布：先把当前表单落成草稿（发布本来就写在这套草稿名下），再写回配置页 */
	const publishPreset = async (name: string, force = false): Promise<void> => {
		setConflictRemote(null);
		const page = targetPage();
		try {
			await api.rulesets.save(name, encodeRuleset({ ...form, rules: form.rules.filter((rule) => rule.from !== '') }), page);
			const result = await api.rulesets.publish(name, { page, force });
			setNotice({ text: `已发布到 ${page}（revid ${result.revid ?? '未知'}）。`, kind: 'info' });
			refreshPresets();
		} catch (reason) {
			// 发布冲突的响应体不含 error 字段，ApiError.message 会退化成「请求失败（409）」，
			// 必须读 body.reason 与 body.remote 才能给用户看明白
			const reasonCode = reason instanceof ApiError ? reason.body?.reason : undefined;
			if (reason instanceof ApiError && (reasonCode === 'conflict' || reasonCode === 'missing')) {
				setNotice({ text: publishConflictText(reasonCode), kind: 'error' });
				const remote = reason.body?.remote;
				setConflictRemote(typeof remote === 'string' ? remote : null);
				return;
			}
			setNotice({ text: reason instanceof ApiError ? reason.message : '发布失败', kind: 'error' });
		}
	};

	const running = task?.status === 'running';
	const shownError = error ?? loadError;
	const unsyncedSelected = (nsList?.namespaces ?? []).filter((ns) => form.namespaces.includes(ns.id) && !ns.mirrored);
	// 可载入的扫描结果：刷新后才收到 done 回放的优先，否则用列表里当前站点最新那份
	const loadableScan = recoveredScan ?? (latestScan !== null ? scanFileNameOf(latestScan) : null);

	return (
		<section className="text-replace-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>全站文本替换</h2>
			</div>

			{shownError !== null && <p className="error">{shownError}</p>}
			{notice !== null && <p className={notice.kind === 'error' ? 'error' : 'hint'}>{notice.text}</p>}
			{descriptor === null && loadError === null && <p className="hint">正在加载…</p>}

			{descriptor !== null && (
				<>
					<ProgressPanel task={task} events={events} onAbort={() => void abort()} aborting={busy && running} />

					<div className="tr-form">
						<label className="tr-wiki">
							<span>站点</span>
							<select value={wiki} disabled={running} onChange={(event) => setWiki(event.target.value === 'cm' ? 'cm' : 'zh')}>
								<option value="zh">萌娘百科</option>
								<option value="cm">共享站</option>
							</select>
						</label>

						<h3>规则（从 → 到）</h3>
						<RuleEditor rules={form.rules} disabled={running} onChange={(rules) => setForm((prev) => ({ ...prev, rules }))} />

						<h3>页面 / 分类清单</h3>
						<p className="hint">
							一行一个页面标题；分类行以 分类: / Category: / Cat: 开头，展开其直属页面成员（不递归子分类）。用清单时不必先扫描，也不读镜像。
						</p>
						<textarea
							className="tr-targets"
							rows={6}
							value={targetList}
							disabled={running}
							placeholder={'苹果\nCategory:Vocaloid'}
							onChange={(event) => setTargetList(event.target.value)}
						/>
						<div className="tr-actions">
							<button type="button" disabled={running || busy} onClick={() => void startAction('targets-dry')}>
								空跑清单
							</button>
							<button type="button" className="primary" disabled={running || busy} onClick={() => void startAction('targets')}>
								替换清单
							</button>
						</div>

						<h3>命名空间</h3>
						<NamespacePicker
							namespaces={nsList?.namespaces ?? []}
							selected={form.namespaces}
							disabled={running}
							fetching={fetchingNs}
							onChange={(namespaces) => setForm((prev) => ({ ...prev, namespaces }))}
							onFetch={(id) => void startAction('sync', id)}
							onSync={() => void startAction('sync')}
						/>

						<h3>预设</h3>
						<PresetPicker
							presets={presets}
							name={presetName}
							onNameChange={setPresetName}
							page={configPage.trim() !== '' ? configPage.trim() : configPageFor(presetName)}
							onPageChange={setConfigPage}
							onLoad={(name) => void loadPreset(name)}
							onSave={(name) => void savePreset(name)}
							onPublish={(name) => void publishPreset(name)}
							busy={busy}
						/>
						{conflictRemote !== null && (
							<>
								<p>
									<button type="button" disabled={running || busy} onClick={() => void publishPreset(presetName.trim(), true)}>
										以线上当前版本为基线覆盖
									</button>
								</p>
								<details className="conflict-remote">
									<summary>线上配置页当前内容</summary>
									<pre>{conflictRemote}</pre>
								</details>
							</>
						)}

						<div className="tr-actions">
							<button type="button" className="primary" disabled={running || busy} onClick={() => void startAction('scan')}>
								扫描
							</button>
							<button type="button" disabled={running || busy} onClick={() => void startAction('dryrun')}>
								空跑
							</button>
							{unsyncedSelected.length > 0 && <span className="hint danger">勾选中有 {unsyncedSelected.length} 个命名空间未同步</span>}
						</div>

						{scanName === null && loadableScan !== null && (
							// 扫描结果已落盘，刷新页面也能取回：不必重扫
							<p className="hint">
								{recoveredScan !== null ? '上一次扫描的结果已落盘：' : '最近一次扫描结果：'}
								<button type="button" className="scan-recall" disabled={running || busy} onClick={() => void loadScanResult(loadableScan)}>
									载入 {loadableScan}
								</button>
								{recoveredScan === null && latestScan !== null && `（命中 ${latestScan.hitCount} 页）`}
							</p>
						)}
					</div>

					{scanName !== null && (
						<>
							<HitList
								key={scanName}
								scanName={scanName}
								hits={hits}
								total={hitTotal}
								selected={selected}
								loadingMore={loadingMore}
								onToggle={(title, checked) => {
									const next = new Set(selected);
									if (checked) next.add(title);
									else next.delete(title);
									setSelected(next);
								}}
								onSelectAll={() => setSelected(new Set(hits.map((hit) => hit.title)))}
								onSelectNone={() => setSelected(new Set())}
								onLoadMore={() => void loadMore()}
							/>
							<div className="tr-submit">
								<button type="button" className="primary" disabled={running || busy || selected.size === 0} onClick={() => void startAction('submit')}>
									提交选中的 {selected.size} 页
								</button>
							</div>
						</>
					)}

					<LogView events={events} />
				</>
			)}
		</section>
	);
}
