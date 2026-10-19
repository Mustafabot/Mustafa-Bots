// 链接替换页：把配置页的 JSON 表单化，直接在界面上改、运行、看逐页改动。
//
// 配置的权威形状在 src/replace/LinkReplace.ts；界面用 linkConfigCodec 镜像一份。
// 配置页只在「保存到配置页」时才写回，运行走 --config-file（服务端落临时文件）。
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { LinkRuleList } from '../components/LinkRuleList';
import { decodeLinkConfig, encodeLinkConfig, emptyLinkConfig, validateLinkConfigForm, type LinkConfigForm } from '../linkConfigCodec';
import type { LinkConfigPage, NamespaceInfo, PageWriteResult } from '../types';

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

	// 载入指定配置页；页标题作为参数传入，避免输入框每敲一个字就触发一次读取
	const loadConfig = useCallback(async (page: string): Promise<void> => {
		try {
			const result = await api.linkConfig.load(page);
			setLoaded(result);
			setForm(decodeLinkConfig(result.content));
			setConflict(null);
			setNotice({ text: `已载入 ${result.page}。`, kind: 'info' });
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

	/** 保存草稿到配置页；冲突时显示线上内容供比对，可强制覆盖 */
	const saveConfig = async (force = false): Promise<void> => {
		const problems = validateLinkConfigForm(form);
		if (problems.length > 0) {
			setNotice({ text: `先修好这些再保存：${problems.join('；')}`, kind: 'error' });
			return;
		}
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
					<button type="button" onClick={() => void saveConfig()}>
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
					<button type="button" onClick={() => void saveConfig(true)}>
						以线上当前版本为基线覆盖
					</button>
					<button type="button" onClick={() => void loadConfig(configPage.trim())}>
						丢弃本地改动，重新载入
					</button>
				</div>
			)}
		</section>
	);
}
