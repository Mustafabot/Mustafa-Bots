// 链接替换配置的表单编解码。
//
// 配置页 JSON 的形状由 src/replace/LinkReplace.ts 的 BotConfig 决定（界面不能 import 那边的
// Node 模块，故镜像一份）。空字段在编码时省略，让配置页读起来像手写的；解码宽容，
// 坏 JSON 或错类型一律退回可用默认值，界面永远拿到能渲染的表单。

export interface LinkRule {
	from: string;
	to: string;
}

export interface LinkTemplateRow {
	name: string;
	/** 参数位：`1`、`1,2` 或 `all`，编码时转成数字、数字数组或字符串 */
	param: string;
	/** 显示文字参数位，空表示没有 */
	displayParam: string;
	/** 参数值内的分隔符字符集，空表示没有 */
	valueSeparator: string;
}

export interface LinkConfigForm {
	mode: 'replace' | 'move';
	namespaces: number[];
	pages: string[];
	noredirect: boolean;
	movetalk: boolean;
	linkTemplates: LinkTemplateRow[];
	replacements: LinkRule[];
}

/** 空表单：replace 模式、没有页面来源与规则 */
export function emptyLinkConfig(): LinkConfigForm {
	return { mode: 'replace', namespaces: [], pages: [], noredirect: false, movetalk: true, linkTemplates: [], replacements: [] };
}

/** 把参数位文本解析成脚本要的形状；无法解析时返回 undefined */
function parseParam(text: string): number | number[] | 'all' | undefined {
	const trimmed = text.trim();
	if (trimmed === '') return undefined;
	if (trimmed === 'all') return 'all';
	const parts = trimmed.split(',').map((part) => Number(part.trim()));
	if (parts.some((n) => !Number.isInteger(n) || n < 0) || parts.length === 0) return undefined;
	return parts.length === 1 ? parts[0] : parts;
}

/** 把脚本的形状还原成参数位文本 */
function renderParam(value: unknown): string {
	if (value === 'all') return 'all';
	if (typeof value === 'number') return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value.join(',');
	return '';
}

/** 表单 → 配置 JSON 文本 */
export function encodeLinkConfig(form: LinkConfigForm): string {
	const payload: Record<string, unknown> = { mode: form.mode };
	if (form.namespaces.length > 0) payload.namespaces = [...form.namespaces];
	if (form.pages.length > 0) payload.pages = form.pages.filter((page) => page.trim() !== '').map((page) => page.trim());
	if (form.mode === 'move') payload.move = { noredirect: form.noredirect, movetalk: form.movetalk };
	const templates = form.linkTemplates
		.filter((row) => row.name.trim() !== '')
		.map((row) => {
			const param = parseParam(row.param);
			if (param === undefined) return null;
			const template: Record<string, unknown> = { name: row.name.trim(), param };
			if (row.displayParam.trim() !== '') {
				const display = parseParam(row.displayParam);
				if (typeof display === 'number') template.displayParam = display;
			}
			if (row.valueSeparator.trim() !== '') template.valueSeparator = row.valueSeparator.trim();
			return template;
		})
		.filter((item): item is Record<string, unknown> => item !== null);
	if (templates.length > 0) payload.linkTemplates = templates;
	payload.replacements = form.replacements
		.filter((rule) => rule.from.trim() !== '' && rule.to.trim() !== '')
		.map((rule) => ({ from: rule.from.trim(), to: rule.to.trim() }));
	return JSON.stringify(payload, null, '\t');
}

/** 取字符串；非字符串当没有 */
function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** 配置 JSON 文本 → 表单；坏 JSON 或结构不对时退回默认值，不抛错 */
export function decodeLinkConfig(content: string): LinkConfigForm {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return emptyLinkConfig();
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyLinkConfig();
	const data = parsed as Record<string, unknown>;
	const form = emptyLinkConfig();
	form.mode = data.mode === 'move' ? 'move' : 'replace';
	form.namespaces = Array.isArray(data.namespaces)
		? data.namespaces.filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0)
		: [];
	form.pages = Array.isArray(data.pages) ? data.pages.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
	const move = (data.move !== null && typeof data.move === 'object' ? data.move : {}) as Record<string, unknown>;
	form.noredirect = move.noredirect === true;
	form.movetalk = move.movetalk !== false;
	form.linkTemplates = Array.isArray(data.linkTemplates)
		? data.linkTemplates
				.map((item): LinkTemplateRow | null => {
					if (item === null || typeof item !== 'object') return null;
					const row = item as Record<string, unknown>;
					return {
						name: text(row.name),
						param: renderParam(row.param),
						displayParam: renderParam(row.displayParam),
						valueSeparator: text(row.valueSeparator),
					};
				})
				.filter((row): row is LinkTemplateRow => row !== null)
		: [];
	form.replacements = Array.isArray(data.replacements)
		? data.replacements
				.map((item): LinkRule | null => {
					if (item === null || typeof item !== 'object') return null;
					const rule = item as Record<string, unknown>;
					const from = text(rule.from);
					const to = text(rule.to);
					return from.trim() === '' || to.trim() === '' ? null : { from, to };
				})
				.filter((rule): rule is LinkRule => rule !== null)
		: [];
	return form;
}
