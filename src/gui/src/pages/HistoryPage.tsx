// 历史页：任务清单（可搜可筛）+ 选中任务的详情（当时参数、改动页面、新旧 revid）+ 按需看 diff。
//
// 数据全部来自服务端历史库（只存任务元数据与页面新旧 revid，正文不落库）：
//   - api.history.list()        任务清单
//   - api.history.detail(id)    某任务的参数与逐页记录
//   - api.history.diff(id,page) 现取那一页改前改后的正文并算 diff
//
// 「回退选中的 N 页」属第二批：本批只放一个禁用占位，不做任何回退动作，
// 页面行的勾选框也只维护勾选状态、不触发任何操作。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { DiffView } from '../components/DiffView';
import { formatDuration } from '../components/progressText';
import { decodeRuleset } from '../rulesetCodec';
import type { DiffLine, HistoryPageRow, HistoryTaskDetail, HistoryTaskParams, HistoryTaskRow } from '../types';

/** 任务状态中文标签；未知状态原样显示 */
const STATUS_LABEL: Record<string, string> = {
	running: '运行中',
	succeeded: '成功',
	failed: '失败',
	aborted: '已中止',
};

/** done 摘要里常见键的中文标签；未知键原样显示（自动巡查的键如 `zh_阶段1成功` 走这条） */
const SUMMARY_LABEL: Record<string, string> = {
	changed: '修改',
	skipped: '跳过',
	staleSkipped: '跳过',
	failed: '失败',
	hits: '命中',
	scanned: '扫描',
	edited: '编辑',
	dryRun: '空跑',
	added: '新增',
	removed: '删除',
};

/** 一条页面记录的动作标签 */
const ACTION_LABEL: Record<string, string> = {
	changed: '已修改',
	skipped: '跳过',
	failed: '失败',
};

/** 命令行开关的中文标签（详情参数用）；未收录的开关原样显示 */
const FLAG_LABEL: Record<string, string> = {
	'--scan-only': '只扫描不修改',
	'--dry-run': '空跑',
	'--no-sync': '跳过镜像同步',
	'--sync-only': '仅同步镜像',
	'--resync': '清空镜像重同步',
	'--reset': '重置断点',
	'--purge-deleted': '真删已删页面',
	'--ignore-case': '忽略大小写',
	'--regex': '正则',
	'--summary': '编辑摘要',
	'--interval': '间隔（毫秒）',
	'--days': '回溯天数',
	'--limit': '数量上限',
	'--mode': '模式',
};

/** 一个页面展开的 diff 状态 */
type DiffState =
	| { status: 'loading' }
	| { status: 'lines'; lines: DiffLine[] }
	| { status: 'note'; text: string }
	| { status: 'error'; text: string };

/** 时间戳转「YYYY-MM-DD HH:MM」（本地时区） */
function formatTime(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 安全解析 JSON 字符串为对象；坏值或非对象一律退回空对象 */
function parseJsonObject(text: string | null): Record<string, unknown> {
	if (text === null) return {};
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** 解析落库的参数对象；非对象或坏 JSON 退回空对象 */
function parseParams(paramsJson: string): HistoryTaskParams {
	return parseJsonObject(paramsJson) as HistoryTaskParams;
}

/** 命名空间编号转显示名：主命名空间单独标出，其余按编号 */
function namespaceLabel(id: string): string {
	return id === '0' ? '主命名空间' : `命名空间 ${id}`;
}

/** 把任务摘要对象拼成「修改 2，跳过 1」；无摘要返回空串 */
function describeSummary(summaryJson: string | null): string {
	return Object.entries(parseJsonObject(summaryJson))
		.map(([key, value]) => `${SUMMARY_LABEL[key] ?? key} ${String(value)}`)
		.join('，');
}

/** 清单「结果」列：状态 +（有则）摘要 */
function resultText(task: HistoryTaskRow): string {
	const status = STATUS_LABEL[task.status] ?? task.status;
	const summary = describeSummary(task.summaryJson);
	return summary === '' ? status : `${status} · ${summary}`;
}

/** 详情里的一行参数（已转成给人看的标签与取值） */
interface ParamEntry {
	label: string;
	value: string;
}

/** 把 paramsJson（POS /api/task 的 values）转成可读的参数行 */
function describeParams(paramsJson: string): ParamEntry[] {
	const params = parseParams(paramsJson);
	const entries: ParamEntry[] = [];

	const wiki = params['--wiki'];
	if (wiki === 'zh' || wiki === 'cm') entries.push({ label: '站点', value: wiki === 'zh' ? '萌娘百科' : '共享站' });

	const ns = params['--namespace'];
	if (Array.isArray(ns)) entries.push({ label: '命名空间', value: ns.length > 0 ? ns.map((id) => namespaceLabel(String(id))).join('、') : '（用规则集默认范围）' });

	const addNs = params['--add-namespaces'];
	if (Array.isArray(addNs)) entries.push({ label: '抓取的命名空间', value: addNs.map((id) => namespaceLabel(String(id))).join('、') });

	// 其余开关：只列有实际取值的（true 与空串/未设区分开，避免堆一堆「否」）；__ruleset 是规则快照，另处渲染
	for (const [key, value] of Object.entries(params)) {
		if (key === '--wiki' || key === '--namespace' || key === '--add-namespaces' || key === '__ruleset') continue;
		const label = FLAG_LABEL[key] ?? key;
		if (value === true) entries.push({ label, value: '是' });
		else if (value === false || value === '') continue;
		else if (typeof value === 'string' || typeof value === 'number') entries.push({ label, value: String(value) });
		else if (Array.isArray(value)) entries.push({ label, value: value.map((item) => String(item)).join('、') });
	}
	return entries;
}

/** 详情里的一条规则（从 → 到） */
interface RuleView {
	from: string;
	to: string;
	regex: boolean;
}

/**
 * 从落库参数里取当时规则集的快照。
 * 服务端在有规则集时才落 `__ruleset`；旧记录（本改造之前跑的）没有这个键，`recorded` 为 false。
 */
function describeRules(paramsJson: string): { rules: RuleView[]; recorded: boolean } {
	const snapshot = parseParams(paramsJson).__ruleset;
	if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object') return { rules: [], recorded: false };
	const content = (snapshot as { content?: unknown }).content;
	if (typeof content !== 'string') return { rules: [], recorded: true };
	return { rules: decodeRuleset(content).rules, recorded: true };
}

/** 没有改后修订的行（空跑/跳过/失败）不提供 [看 diff]，改给一句说明 */
function noDiffNote(row: HistoryPageRow): string {
	if (row.action === 'skipped') return '未修改，无改动可看';
	if (row.action === 'failed') return '未成功修改，无改动可看';
	return '空跑记录，无改动可看';
}

/** 一行页面记录里「改前改后」的文字；取不到的版本以「—」占位 */
function revidText(row: HistoryPageRow): string {
	const old = row.oldRevid === null ? '—' : String(row.oldRevid);
	const next = row.newRevid === null ? '—' : String(row.newRevid);
	return `改前 revid ${old} → 改后 revid ${next}`;
}

/** 历史页 */
export function HistoryPage(): React.JSX.Element {
	const [tasks, setTasks] = useState<HistoryTaskRow[] | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [typeFilter, setTypeFilter] = useState('all');
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<HistoryTaskDetail | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
	const [open, setOpen] = useState<Set<string>>(new Set());
	// 记住当前选中的任务：详情请求是异步的，切行很快时只认最后一次点击的结果
	const selectedRef = useRef<string | null>(null);

	useEffect(() => {
		let alive = true;
		api.history
			.list()
			.then((result) => {
				if (alive) setTasks(result.tasks);
			})
			.catch((reason: unknown) => {
				if (alive) setListError(reason instanceof ApiError ? reason.message : '无法加载历史记录');
			});
		return () => {
			alive = false;
		};
	}, []);

	// 任务类型筛选的选项：清单里实际出现过的任务名
	const labels = useMemo(() => [...new Set((tasks ?? []).map((task) => task.label))], [tasks]);

	// 搜索匹配任务名、参数 JSON 与任务号；筛选按任务名精确相等
	const filtered = useMemo(() => {
		const keyword = query.trim();
		return (tasks ?? []).filter((task) => {
			if (typeFilter !== 'all' && task.label !== typeFilter) return false;
			if (keyword === '') return true;
			return task.label.includes(keyword) || task.paramsJson.includes(keyword) || task.id.includes(keyword);
		});
	}, [tasks, query, typeFilter]);

	/** 选中一行：清空上一条的详情与 diff 状态，再取新详情 */
	const selectTask = (id: string): void => {
		if (id === selectedRef.current) return;
		selectedRef.current = id;
		setSelectedId(id);
		setDetail(null);
		setDetailError(null);
		setChecked(new Set());
		setDiffs({});
		setOpen(new Set());
		api.history
			.detail(id)
			.then((result) => {
				if (selectedRef.current === id) setDetail(result);
			})
			.catch((reason: unknown) => {
				if (selectedRef.current === id) setDetailError(reason instanceof ApiError ? reason.message : '无法加载任务详情');
			});
	};

	/** 展开/收起某页的 diff；首次展开才现取 */
	const toggleDiff = (title: string): void => {
		if (selectedId === null) return;
		const next = new Set(open);
		if (next.has(title)) {
			next.delete(title);
			setOpen(next);
			return;
		}
		next.add(title);
		setOpen(next);
		if (diffs[title] !== undefined) return;
		setDiffs((prev) => ({ ...prev, [title]: { status: 'loading' } }));
		api.history
			.diff(selectedId, title)
			.then((result) => setDiffs((prev) => ({ ...prev, [title]: { status: 'lines', lines: result.lines } })))
			.catch((reason: unknown) => {
				// unchanged / missing 是业务状态而非错误，转成友好文案；其余才标红
				const reasonCode = reason instanceof ApiError ? reason.body?.reason : undefined;
				if (reasonCode === 'unchanged') setDiffs((prev) => ({ ...prev, [title]: { status: 'note', text: '两个版本内容相同，看不出差异' } }));
				else if (reasonCode === 'missing') setDiffs((prev) => ({ ...prev, [title]: { status: 'note', text: '页面不存在或版本取不到' } }));
				else setDiffs((prev) => ({ ...prev, [title]: { status: 'error', text: reason instanceof ApiError ? reason.message : '取 diff 失败' } }));
			});
	};

	const renderDiff = (title: string): React.JSX.Element | null => {
		const state = diffs[title];
		if (state === undefined) return null;
		if (state.status === 'loading') return <p className="hint">正在取 diff…</p>;
		if (state.status === 'lines') return <DiffView lines={state.lines} />;
		if (state.status === 'note') return <p className="hint">{state.text}</p>;
		return <p className="error">{state.text}</p>;
	};

	const paramEntries = detail === null ? [] : describeParams(detail.task.paramsJson);
	const ruleInfo = detail === null ? { rules: [] as RuleView[], recorded: false } : describeRules(detail.task.paramsJson);

	return (
		<section className="history-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>历史记录</h2>
			</div>

			{listError !== null && <p className="error">{listError}</p>}
			{tasks === null && listError === null && <p className="hint">正在加载…</p>}

			{tasks !== null && (
				<>
					<div className="history-toolbar">
						<label className="history-search">
							<span>搜索</span>
							<input type="search" value={query} placeholder="任务名 / 参数 / 任务号" onChange={(event) => setQuery(event.target.value)} />
						</label>
						<label className="history-filter">
							<span>筛选</span>
							<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
								<option value="all">全部任务</option>
								{labels.map((label) => (
									<option key={label} value={label}>
										{label}
									</option>
								))}
							</select>
						</label>
					</div>

					<table className="history-table">
						<thead>
							<tr>
								<th>时间</th>
								<th>任务</th>
								<th>用时</th>
								<th>结果</th>
							</tr>
						</thead>
						<tbody>
							{filtered.length === 0 && (
								<tr>
									<td className="hint" colSpan={4}>
										{tasks.length === 0 ? '还没有历史记录。' : '没有符合条件的记录。'}
									</td>
								</tr>
							)}
							{filtered.map((task) => (
								<tr key={task.id} className={`history-row${task.id === selectedId ? ' selected' : ''}`} onClick={() => selectTask(task.id)}>
									<td className="history-time">{formatTime(task.startedAt)}</td>
									<td>{task.label}</td>
									<td className="history-duration">{task.endedAt === null ? '—' : formatDuration(task.endedAt - task.startedAt)}</td>
									<td>{resultText(task)}</td>
								</tr>
							))}
						</tbody>
					</table>

					{detailError !== null && <p className="error">{detailError}</p>}
					{selectedId !== null && detail === null && detailError === null && <p className="hint">正在加载详情…</p>}

					{detail !== null && (
						<div className="history-detail">
							<h3>
								详情：{detail.task.label} · {formatTime(detail.task.startedAt)} · {STATUS_LABEL[detail.task.status] ?? detail.task.status}
							</h3>

							<div className="history-rules">
								{!ruleInfo.recorded && <p className="hint">（未记录规则）</p>}
								{ruleInfo.recorded && ruleInfo.rules.length === 0 && <p className="hint">这次任务没有记录规则。</p>}
								{ruleInfo.rules.map((rule, index) => (
									<p className="history-rule" key={index}>
										规则：<code>{rule.regex ? `/${rule.from}/` : rule.from}</code>
										<span className="rule-arrow">→</span>
										<code>{rule.to === '' ? '（置空）' : rule.to}</code>
									</p>
								))}
							</div>

							<dl className="history-params">
								{paramEntries.map((entry, index) => (
									<div className="history-param" key={`${entry.label}-${index}`}>
										<dt>{entry.label}</dt>
										<dd>{entry.value}</dd>
									</div>
								))}
								{ruleInfo.recorded && (
									<div className="history-param">
										<dt>规则数</dt>
										<dd>{ruleInfo.rules.length} 条</dd>
									</div>
								)}
								{paramEntries.length === 0 && !ruleInfo.recorded && (
									<div className="history-param">
										<dt>参数</dt>
										<dd>（无）</dd>
									</div>
								)}
							</dl>

							<h4>改动的页面（{detail.pages.length}）</h4>
							{detail.pages.length === 0 && <p className="hint">这次任务没有逐页记录（例如只做扫描或同步，也可能未产生任何编辑事件）。</p>}
							<ul className="history-pages">
								{detail.pages.map((row) => (
									<li className="history-page-row" key={row.title}>
										<div className="history-page-line">
											<input
												type="checkbox"
												checked={checked.has(row.title)}
												onChange={(event) => {
													const next = new Set(checked);
													if (event.target.checked) next.add(row.title);
													else next.delete(row.title);
													setChecked(next);
												}}
											/>
											<span className="history-page-title">{row.title}</span>
											<span className={`history-action history-action-${row.action}`}>{ACTION_LABEL[row.action] ?? row.action}</span>
											<span className="history-revids">{revidText(row)}</span>
											{row.newRevid === null ? (
												// 没有改后修订（空跑/跳过/失败）：无可比版本，给说明而非点了必然落 missing 的 [看 diff]
												<span className="hint history-no-diff">{noDiffNote(row)}</span>
											) : (
												<button type="button" className="history-diff-btn" onClick={() => toggleDiff(row.title)}>
													{open.has(row.title) ? '收起 diff' : '看 diff'}
												</button>
											)}
										</div>
										{row.message !== null && row.message !== '' && <p className="hint history-page-msg">{row.message}</p>}
										{open.has(row.title) && <div className="history-diff">{renderDiff(row.title)}</div>}
									</li>
								))}
							</ul>

							<div className="history-revert">
								<button type="button" disabled title="回退功能将在第二批提供">
									回退选中的 {checked.size} 页
								</button>
								<span className="hint">（第二批）</span>
							</div>
						</div>
					)}
				</>
			)}
		</section>
	);
}
