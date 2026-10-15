/**
 * 文本替换的规则引擎：规则校验、预编译、命中查找与替换执行。
 * 与站点、镜像、网络都无关的纯逻辑，供 TextReplace 与扫描结果提取共用。
 */
import { createHash } from 'crypto';

/** 单条替换规则（CLI 参数或 JSON 配置的 rules 元素） */
export interface ReplaceRule {
	/** 查找文本；regex 为 true 时按 JavaScript 正则解析 */
	from: string;
	/** 替换文本；regex 为 true 时支持 $1 等替换引用，可为空串（即删除） */
	to: string;
	/** 是否按正则解析 from */
	regex?: boolean;
	/** 是否忽略大小写 */
	ignoreCase?: boolean;
}

/** 一处命中在整篇文本中的位置 */
export interface MatchSpan {
	/** 命中起点在全文中的字符下标 */
	index: number;
	/** 实际匹配到的字串（正则模式下是匹配文本，不是模式本身） */
	value: string;
}

/** 预编译后的规则：命中计数、明细提取与替换执行各有闭包，避免逐页重新编译正则 */
export interface PreparedRule {
	rule: ReplaceRule;
	/** 返回 from 在文本中的出现次数（0 表示未命中） */
	countMatches: (text: string) => number;
	/** 返回全部命中位置，供命中明细提取 */
	findMatches: (text: string) => MatchSpan[];
	/** 在文本上执行替换，返回新文本与替换次数 */
	apply: (text: string) => { text: string; count: number };
}

/** 截断过长文本用于日志与摘要 */
export function trunc(text: string, max = 50): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 正则元字符转义（纯文本 + 忽略大小写时把字面量转为等价正则） */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 校验单条规则，返回错误信息或 null */
export function validateRule(rule: ReplaceRule, label: string): string | null {
	if (typeof rule.from !== 'string' || rule.from === '') return `${label} 缺少 from`;
	if (typeof rule.to !== 'string') return `${label} 缺少 to（可为空串）`;
	if (rule.regex !== undefined && typeof rule.regex !== 'boolean') return `${label} regex 必须是布尔值`;
	if (rule.ignoreCase !== undefined && typeof rule.ignoreCase !== 'boolean') return `${label} ignoreCase 必须是布尔值`;
	if (rule.regex) {
		try {
			new RegExp(rule.from, `g${rule.ignoreCase ? 'i' : ''}`);
		} catch (error) {
			return `${label} from 不是合法正则: ${(error as Error).message}`;
		}
	} else if (rule.from === rule.to) {
		return `${label} from 与 to 相同`;
	}
	return null;
}

/** 枚举正则的全部命中；零宽匹配手动推进 lastIndex，否则会死循环 */
function execAll(re: RegExp, text: string): MatchSpan[] {
	const spans: MatchSpan[] = [];
	re.lastIndex = 0;
	for (let matched = re.exec(text); matched !== null; matched = re.exec(text)) {
		spans.push({ index: matched.index, value: matched[0] });
		if (matched[0] === '') re.lastIndex++;
	}
	return spans;
}

/** 预编译规则：纯文本（区分大小写）用字符串操作；其余情况用带 g 的正则 */
export function prepareRule(rule: ReplaceRule): PreparedRule {
	if (rule.regex || rule.ignoreCase) {
		const source = rule.regex ? rule.from : escapeRegExp(rule.from);
		const flags = `g${rule.ignoreCase ? 'i' : ''}`;
		// 三个独立实例，避免 g 标志的 lastIndex 在计数、明细与替换之间互相影响
		const countRe = new RegExp(source, flags);
		const detailRe = new RegExp(source, flags);
		const replaceRe = new RegExp(source, flags);
		return {
			rule,
			countMatches: (text) => text.match(countRe)?.length ?? 0,
			findMatches: (text) => execAll(detailRe, text),
			apply: (text) => {
				const count = text.match(countRe)?.length ?? 0;
				return { text: count > 0 ? text.replace(replaceRe, rule.to) : text, count };
			},
		};
	}
	return {
		rule,
		countMatches: (text) => (text.includes(rule.from) ? text.split(rule.from).length - 1 : 0),
		findMatches: (text) => {
			const spans: MatchSpan[] = [];
			let from = 0;
			for (;;) {
				const index = text.indexOf(rule.from, from);
				if (index === -1) break;
				spans.push({ index, value: rule.from });
				from = index + rule.from.length;
			}
			return spans;
		},
		apply: (text) => {
			const count = text.split(rule.from).length - 1;
			// split/join 保证 to 按字面处理（$ 等字符不被解释）
			return { text: count > 0 ? text.split(rule.from).join(rule.to) : text, count };
		},
	};
}

/** 规则的展示标签：正则用 /…/ 包裹，纯文本用引号 */
export function describeRule(rule: ReplaceRule): string {
	const from = rule.regex ? `/${trunc(rule.from, 40)}/` : `"${trunc(rule.from, 40)}"`;
	return `${from} → "${trunc(rule.to, 40)}"`;
}

/**
 * 任务指纹：同一套参数得到同一串，参数一变指纹就变。
 * 用作编辑断点与扫描结果的作废依据；字段顺序固定，不要重排。
 */
export function computeFingerprint(input: { wiki: string; namespaces: number[]; rules: ReplaceRule[]; titles?: string[] }): string {
	return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
