// 链接替换页：把配置页的 JSON 表单化，直接在界面上改、运行、看逐页改动。
//
// 配置的权威形状在 src/replace/LinkReplace.ts；界面用 linkConfigCodec 镜像一份。
// 配置页只在「保存到配置页」时才写回，运行走 --config-file（服务端落临时文件）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { DiffView } from '../components/DiffView';
import { LinkRuleList } from '../components/LinkRuleList';
import { LogView } from '../components/LogView';
import { ProgressPanel } from '../components/ProgressPanel';
import { useTaskRun } from '../hooks/useTaskRun';
import { decodeLinkConfig, encodeLinkConfig, emptyLinkConfig, validateLinkConfigForm, type LinkConfigForm } from '../linkConfigCodec';
import type { DiffLine, LinkConfigPage, NamespaceInfo, PageWriteResult, TaskDescriptor } from '../types';

/** 配置页的默认标题 */
const DEFAULT_CONFIG_PAGE = 'User:没有羽翼的格雷塔/BotConfig/LinkReplace.json';

/** 链接替换页 */
export function LinkReplacePage(): React.JSX.Element {
	const [configPage, setConfigPage] = useState(DEFAULT_CONFIG_PAGE);
	const [loaded, setLoaded] = useState<LinkConfigPage | null>(null);
	const [form, setForm] = useState<LinkConfigForm>(emptyLinkConfig);
	const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
	const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
	const [conflict, setConflict] = useState<{ remote: string | null; reason: string } | null>(null);
	// 保存请求进行中：挡住双击触发的第二次 PUT（否则会用旧基线第二次提交，误报冲突）
	const [saving, setSaving] = useState(false);
	const [descriptor, setDescriptor] = useState<TaskDescriptor | null>(null);

	// 运行方式：空跑只查不改；「丢弃断点」勾上时带 --reset
	const [resetCheckpoint, setResetCheckpoint] = useState(false);

	// 载入指定配置页；页标题作为参数传入，避免输入框每敲一个字就触发一次读取。
	// 只在出错时写 notice——保存成功后回读时，别用「已载入」盖掉「配置已保存」。
	const loadConfig = useCallback(async (page: string): Promise<void> => {
		try {
			const result = await api.linkConfig.load(page);
			setLoaded(result);
			setForm(decodeLinkConfig(result.content));
			setConflict(null);
		} catch (reason) {
			setNotice({ text: reason instanceof ApiError ? reason.message : '载入配置失败', kind: 'error' });
		}
	}, []);

	// 进页面载入一次默认配置页；之后由「载入」按钮触发
	useEffect(() => {
		void loadConfig(DEFAULT_CONFIG_PAGE);
	}, [loadConfig]);

	// 命名空间列表只取一次
	useEffect(() => {
		let alive = true;
		api.namespaces('zh')
			.then((result) => {
				if (alive) setNamespaces(result.namespaces);
			})
			.catch(() => {
				// 命名空间拿不到不影响其它字段
			});
		return () => {
			alive = false;
		};
	}, []);

	// 取描述符（运行按钮据此拼命令行；服务端会自动注入 --config-file 与进度开关）
	useEffect(() => {
		let alive = true;
		api.descriptors()
			.then((result) => {
				if (alive) setDescriptor(result.descriptors.find((item) => item.id === 'link-replace') ?? null);
			})
			.catch(() => {
				// 登录门已在 App 处理
			});
		return () => {
			alive = false;
		};
	}, []);

	// 任务编排（SSE + 启动/中止 + 状态）与其它页面共用一份
	const { task, events, busy, error, start, abort } = useTaskRun();
	const running = task?.status === 'running';

	/** 一次运行里逐页的结果：title → { status, message } */
	const results = useMemo(() => {
		const map = new Map<string, { status: string; message: string }>();
		for (const event of events) {
			if (event.type !== 'edit') continue;
			map.set(event.title, { status: event.status, message: event.message ?? '' });
		}
		return map;
	}, [events]);

	/** 打开或收起某页的 diff；任务结束后历史已落库，走按新旧 revid 取正文那条路 */
	const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set());
	const [diffLines, setDiffLines] = useState<Record<string, DiffLine[]>>({});
	const [diffError, setDiffError] = useState<Record<string, string>>({});
	const toggleDiff = (title: string): void => {
		const next = new Set(openDiffs);
		if (next.has(title)) {
			next.delete(title);
			setOpenDiffs(next);
			return;
		}
		next.add(title);
		setOpenDiffs(next);
		if (task === null || diffLines[title] !== undefined) return;
		api.history
			.diff(task.id, title)
			.then((result) => setDiffLines((prev) => ({ ...prev, [title]: result.lines })))
			.catch((reason: unknown) => {
				const reasonCode = reason instanceof ApiError ? (reason.body as { reason?: string } | null)?.reason : undefined;
				const text = reasonCode === 'unchanged' ? '这一页没有实际改动' : reasonCode === 'missing' ? '线上已找不到这个页面' : reason instanceof ApiError ? reason.message : '取 diff 失败';
				setDiffError((prev) => ({ ...prev, [title]: text }));
			});
	};

	/** 启动一次运行：空跑带 --dry-run；另按需带 --reset。表单先过一遍校验再下发 */
	const startRun = async (dryRun: boolean): Promise<void> => {
		if (descriptor === null) return;
		const problems = validateLinkConfigForm(form);
		if (problems.length > 0) {
			setNotice({ text: `先修好这些再运行：${problems.join('；')}`, kind: 'error' });
			return;
		}
		// 配置页标题始终下发（可为空串）：脚本用它当断点标识，缺了每次都会换一个临时文件当标识，续跑就失效
		const values: Record<string, boolean | string> = { configPage: configPage.trim() };
		if (dryRun) values['--dry-run'] = true;
		if (resetCheckpoint) values['--reset'] = true;
		setNotice(null);
		await start({
			descriptorId: descriptor.id,
			values,
			rulesetContent: encodeLinkConfig(form),
			rulesetName: configPage.trim() === '' ? '未命名链接替换' : configPage.trim(),
		});
	};

	/** 保存草稿到配置页；冲突时显示线上内容供比对，可强制覆盖 */
	const saveConfig = async (force = false): Promise<void> => {
		const problems = validateLinkConfigForm(form);
		if (problems.length > 0) {
			setNotice({ text: `先修好这些再保存：${problems.join('；')}`, kind: 'error' });
			return;
		}
		setSaving(true);
		try {
			await api.linkConfig.save(configPage.trim(), encodeLinkConfig(form), loaded?.revid ?? null, force);
			setConflict(null);
			setNotice({ text: '配置已保存。', kind: 'info' });
			await loadConfig(configPage.trim());
		} catch (reason) {
			const body = reason instanceof ApiError ? reason.body : null;
			if (body !== null && (body as { ok?: unknown }).ok === false) {
				const failed = body as unknown as Extract<PageWriteResult, { ok: false }>;
				setConflict({ remote: failed.remote, reason: failed.reason });
				return;
			}
			setNotice({ text: reason instanceof ApiError ? reason.message : '保存配置失败', kind: 'error' });
		} finally {
			setSaving(false);
		}
	};

	const toggleNamespace = (id: number, checked: boolean): void => {
		setForm((prev) => ({
			...prev,
			namespaces: checked ? [...prev.namespaces, id] : prev.namespaces.filter((item) => item !== id),
		}));
	};

	return (
		<section className="link-replace-page">
			<div className="page-head">
				<a href="#/">← 返回任务列表</a>
				<h2>链接替换</h2>
			</div>

			{error !== null && <p className="error">{error}</p>}
			{notice !== null && <p className={notice.kind === 'error' ? 'error' : 'hint'}>{notice.text}</p>}

			<div className="lr-config-page">
				<div className="field">
					<label htmlFor="lr-page">配置页</label>
					<input id="lr-page" type="text" value={configPage} onChange={(event) => setConfigPage(event.target.value)} />
				</div>
				<button type="button" onClick={() => void loadConfig(configPage.trim())}>
					载入
				</button>
				<span className="hint">版本：{loaded?.revid ?? '未载入'}</span>
			</div>

			<div className="lr-form">
				<div className="field">
					<label htmlFor="lr-mode">模式</label>
					<select id="lr-mode" value={form.mode} onChange={(event) => setForm((prev) => ({ ...prev, mode: event.target.value === 'move' ? 'move' : 'replace' }))}>
						<option value="replace">仅替换链接</option>
						<option value="move">先把页面移到新标题，再替换</option>
					</select>
				</div>

				{form.mode === 'move' && (
					<div className="lr-move">
						<label>
							<input type="checkbox" checked={form.noredirect} onChange={(event) => setForm((prev) => ({ ...prev, noredirect: event.target.checked }))} />
							移动后不留重定向（无权限时自动降级）
						</label>
						<label>
							<input type="checkbox" checked={form.movetalk} onChange={(event) => setForm((prev) => ({ ...prev, movetalk: event.target.checked }))} />
							连带移动讨论页
						</label>
					</div>
				)}

				<div className="field">
					<label htmlFor="lr-pages">显式页面（一行一个，可留空）</label>
					<textarea id="lr-pages" rows={4} value={form.pages.join('\n')} onChange={(event) => setForm((prev) => ({ ...prev, pages: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') }))} />
				</div>

				<div className="field">
					<span>页面来源的命名空间（链入与嵌入引用按此过滤；不勾则只看显式页面）</span>
				</div>
				<div className="ns-grid">
					{namespaces.map((ns) => (
						<label className="ns-item" key={ns.id}>
							<input type="checkbox" checked={form.namespaces.includes(ns.id)} onChange={(event) => toggleNamespace(ns.id, event.target.checked)} />
							<span>{ns.label}</span>
						</label>
					))}
				</div>

				<h3>替换规则</h3>
				<LinkRuleList rules={form.replacements} onChange={(replacements) => setForm((prev) => ({ ...prev, replacements }))} />

				<h3>模板映射</h3>
				<p className="hint">哪些模板的哪个参数装链接。参数位写数字、逗号分隔的多个数字，或 all；分隔符填参数值内用来分隔多个目标的那几个字符。</p>
				{form.linkTemplates.map((row, index) => (
					<div className="lr-template-row" key={index}>
						<input type="text" value={row.name} placeholder="模板名（可带 Template:）" onChange={(event) => setForm((prev) => ({ ...prev, linkTemplates: prev.linkTemplates.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)) }))} />
						<input type="text" value={row.param} placeholder="参数位" onChange={(event) => setForm((prev) => ({ ...prev, linkTemplates: prev.linkTemplates.map((item, i) => (i === index ? { ...item, param: event.target.value } : item)) }))} />
						<input type="text" value={row.displayParam} placeholder="显示文字参数位" onChange={(event) => setForm((prev) => ({ ...prev, linkTemplates: prev.linkTemplates.map((item, i) => (i === index ? { ...item, displayParam: event.target.value } : item)) }))} />
						<input type="text" value={row.valueSeparator} placeholder="分隔符" onChange={(event) => setForm((prev) => ({ ...prev, linkTemplates: prev.linkTemplates.map((item, i) => (i === index ? { ...item, valueSeparator: event.target.value } : item)) }))} />
						<button type="button" onClick={() => setForm((prev) => ({ ...prev, linkTemplates: prev.linkTemplates.filter((_, i) => i !== index) }))}>
							删除
						</button>
					</div>
				))}
				<button type="button" onClick={() => setForm((prev) => ({ ...prev, linkTemplates: [...prev.linkTemplates, { name: '', param: '', displayParam: '', valueSeparator: '' }] }))}>
					添加模板
				</button>

				<div className="lr-actions">
					<button type="button" disabled={saving} onClick={() => void saveConfig()}>
						保存到配置页
					</button>
				</div>
			</div>

			{conflict !== null && (
				<div className="restore-conflict">
					<p className="error">配置页在编辑期间被改过（{conflict.reason === 'missing' ? '线上已不存在' : '版本不一致'}），本地改动没有写回。</p>
					<details>
						<summary>查看线上当前内容</summary>
						<pre>{conflict.remote ?? '（线上没有内容）'}</pre>
					</details>
					<button type="button" disabled={saving} onClick={() => void saveConfig(true)}>
						以线上当前版本为基线覆盖
					</button>
					<button type="button" onClick={() => void loadConfig(configPage.trim())}>
						丢弃本地改动，重新载入
					</button>
				</div>
			)}

			<ProgressPanel task={task} events={events} onAbort={() => void abort()} aborting={busy && running} />

			<div className="lr-actions">
				<label>
					<input type="checkbox" checked={resetCheckpoint} disabled={running} onChange={(event) => setResetCheckpoint(event.target.checked)} />
					丢弃断点
				</label>
				<button type="button" disabled={running || descriptor === null} onClick={() => void startRun(true)}>
					空跑
				</button>
				<button type="button" className="primary" disabled={running || descriptor === null} onClick={() => void startRun(false)}>
					运行
				</button>
			</div>

			{results.size > 0 && (
				<ul className="lr-results">
					{[...results.entries()].map(([title, result]) => (
						<li className="lr-result" key={title}>
							<div className="restore-line">
								<span className="restore-title">{title}</span>
								<span className={`lr-status lr-status-${result.status}`}>{result.status === 'changed' ? '修改' : result.status === 'skipped' ? '跳过' : '失败'}</span>
								{result.message !== '' && <span className="hint">{result.message}</span>}
								<button type="button" onClick={() => toggleDiff(title)}>
									{openDiffs.has(title) ? '收起 diff' : '看 diff'}
								</button>
							</div>
							{openDiffs.has(title) && (
								<div className="hit-diff">
									{diffLines[title] !== undefined ? <DiffView lines={diffLines[title]} /> : <p className="hint">{diffError[title] ?? '正在取 diff…'}</p>}
								</div>
							)}
						</li>
					))}
				</ul>
			)}

			<LogView events={events} />
		</section>
	);
}
