// 界面表单状态与规则集 JSON 的互转。
//
// 规则集 JSON 的形状（与 TextReplace 的 `--config-file` 一致）：
// `{ summary?, namespaces?, rules: [{ from, to, regex?, ignoreCase? }] }`。
// 界面上只暴露"从/到/正则"三样，`ignoreCase` 保留但不给勾选框——
// regex 为 true 时 `from` 已是 /模式/flags 正则字面量，要不区分大小写就在字面量里写 i（如 /苹果/gi）。

/** 界面上的表单状态 */
export interface RuleFormState {
	rules: Array<{ from: string; to: string; regex: boolean; ignoreCase: boolean }>;
	namespaces: number[];
	summary?: string;
}

/**
 * 表单状态 → 规则集 JSON 字符串（可直接 PUT 给 `/api/rulesets/:name`）。
 * `regex` / `ignoreCase` 为 false 时省略，与手写规则集的惯例一致；
 * `namespaces` 始终写出（为空即空数组），让保存下来的预设内容自洽可读。
 */
export function encodeRuleset(form: RuleFormState): string {
	const rules = form.rules.map((rule) => ({
		from: rule.from,
		to: rule.to,
		...(rule.regex ? { regex: true } : {}),
		...(rule.ignoreCase ? { ignoreCase: true } : {}),
	}));
	const payload: Record<string, unknown> = { rules, namespaces: form.namespaces };
	if (form.summary !== undefined && form.summary !== '') payload.summary = form.summary;
	return JSON.stringify(payload);
}

/**
 * 规则集 JSON 字符串 → 表单状态；JSON 坏掉或字段缺省时给出可用的默认值，不抛错。
 * 无法识别的结构一律退回空规则、空命名空间，保证界面永远拿到能渲染的状态。
 */
export function decodeRuleset(content: string): RuleFormState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { rules: [], namespaces: [] };
	}
	if (parsed === null || typeof parsed !== 'object') return { rules: [], namespaces: [] };

	const data = parsed as Record<string, unknown>;
	const rules: RuleFormState['rules'] = Array.isArray(data.rules)
		? data.rules.map((raw) => {
				const rule = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
				return {
					from: typeof rule.from === 'string' ? rule.from : '',
					to: typeof rule.to === 'string' ? rule.to : '',
					regex: rule.regex === true,
					ignoreCase: rule.ignoreCase === true,
				};
			})
		: [];
	const namespaces = Array.isArray(data.namespaces) ? data.namespaces.filter((item): item is number => typeof item === 'number') : [];

	const state: RuleFormState = { rules, namespaces };
	if (typeof data.summary === 'string' && data.summary !== '') state.summary = data.summary;
	return state;
}
