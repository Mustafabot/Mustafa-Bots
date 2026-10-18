import Parser from 'wikiparser-node';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createZhApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { buildTemplateNameMap } from '../utils/templateRedirects.js';
import { checkModerationQueued, checkModerationQueuedError, extractApiError, isPermissionDeniedError } from '../utils/retry.js';
import { createEmitter, type EmitProgress } from '../core/progress.js';
import type { MwApiParams } from 'wiki-saikou';
import type { ApiEditResponse, ApiMoveResponse, ApiParseResponse, ApiQueryResponse } from 'types-mediawiki-response';

Parser.config = 'moegirl';

interface LinkTemplateConfig {
	/** 模板名（可带或不带 Template: 前缀），重定向自动展开 */
	name: string;
	/** 链接目标所在参数位；数字数组表示候选顺序（首个非空者）；'all' 表示全部匿名参数 */
	param: number | number[] | 'all';
	/** 显示文字参数位，其值与旧标题相同时同步替换 */
	displayParam?: number;
	/** 参数值内的分隔符字符集（如 ',，' 或 '|'），首个分隔符前是链接目标 */
	valueSeparator?: string;
}

interface ReplacementRule {
	from: string;
	to: string;
}

interface MoveConfig {
	/** 移动后不留重定向（需 suppressredirect 权限，失败自动降级为保留重定向） */
	noredirect?: boolean;
	/** 是否连带移动讨论页，默认 true */
	movetalk?: boolean;
}

interface BotConfig {
	/** replace：仅替换链接；move：先把 from 页面移动到 to，再替换链接 */
	mode?: 'replace' | 'move';
	/** 链入/嵌入引用发现的命名空间过滤 */
	namespaces?: number[];
	/** 显式追加的待处理页面，与发现结果取并集 */
	pages?: string[];
	move?: MoveConfig;
	linkTemplates?: LinkTemplateConfig[];
	replacements: ReplacementRule[];
}

interface CliArgs {
	configPage: string;
	dryRun: boolean;
	quiet: boolean;
	interval: number;
	summary?: string;
	reset: boolean;
}

interface Checkpoint {
	configPage: string;
	fingerprint: string;
	completed: string[];
	failed: Record<string, string>;
}

const api = createZhApi();

const DEFAULT_SUMMARY = '机器人：批量替换链接目标';
const USAGE = '用法: npx tsx src/replace/LinkReplace.ts <JSON配置页标题> [--dry-run] [--quiet] [--interval <ms>] [--summary <文本>] [--reset]';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHECKPOINT_DIR = resolve(__dirname, '../../data/checkpoint');
const CHECKPOINT_FILE = (configPage: string) => {
	const safe = configPage.replace(/[\\/:*?"<>|\s]+/g, '_');
	const hash = createHash('md5').update(configPage).digest('hex').slice(0, 8);
	return resolve(CHECKPOINT_DIR, `link_replace_${safe}_${hash}.json`);
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** MediaWiki 标题归一化：下划线转空格、去首尾空白、首字母大写 */
function normalizeTitle(title: string): string {
	const cleaned = title.trim().replace(/_/g, ' ');
	return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : cleaned;
}

/** 每条规则 from/to 的繁简变体集合（含原标题），用于判定"显示文字与旧/新标题实际相同" */
const titleVariantCache = new Map<string, Set<string>>();

const ZH_VARIANTS = ['zh-cn', 'zh-hans', 'zh-hant', 'zh-tw', 'zh-hk'];

/** 从 action=parse 的 HTML 输出中提取首个 <p> 的 HTML 片段 */
function extractFirstParagraph(html: string): string | null {
	const pMatch = /<p>([\s\S]*?)<\/p>/.exec(html);
	return pMatch ? pMatch[1] : null;
}

/** 从 HTML 片段中提取纯文本 */
function htmlToText(fragment: string): string {
	return fragment
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.trim();
}

/** 从 action=parse 的 HTML 输出中提取纯文本（无 <p> 时退化为整段处理） */
function extractParsedText(html: string): string {
	return htmlToText(extractFirstParagraph(html) ?? html);
}

/** 行首为这些字符的标题在多行文本中会被解析为块级语法（标题/列表/缩进/水平线），含 ~~~ 会被替换为签名，均不能安全批量拼接 */
const UNSAFE_LINE_START = /^[=*#:;-]|~~~/;

/** 单次批量变体转换的最大标题数 */
const BATCH_VARIANT_SIZE = 50;

/** 通过 API 把标题转换为各繁简变体，建立变体集合（重复标题只转换一次） */
async function buildTitleVariants(rules: PreparedRule[], log: (msg: string) => void): Promise<void> {
	// 去重收集待转换标题（normalizeTitle 后发送，前导空白已被清除；仅取标题部分，锚点不参与变体转换）
	const titles: string[] = [];
	const seen = new Set<string>();
	for (const rule of rules) {
		for (const title of [rule.fromTitle, rule.toTitle]) {
			const key = normalizeTitle(title);
			if (!seen.has(key)) {
				seen.add(key);
				titles.push(key);
			}
		}
	}

	// 逐个转换：标题含行首块级语法、或批量调用失败/输出行数不齐时的兜底
	const convertOne = async (title: string): Promise<void> => {
		if (titleVariantCache.has(title)) return;
		const set = new Set<string>([title]);
		for (const variant of ZH_VARIANTS) {
			try {
				const { data } = await api.post<ApiParseResponse>({
					action: 'parse',
					text: title,
					contentmodel: 'wikitext',
					variant,
					prop: 'text',
				}, {
					retry: 15,
				} as any);
				const html: string | undefined = data?.parse?.text;
				if (typeof html === 'string') {
					const converted = extractParsedText(html);
					if (converted) set.add(normalizeTitle(converted));
				}
			} catch {
				// 单个变体转换失败时仅保留已取得的变体
			}
			await sleep(300);
		}
		titleVariantCache.set(title, set);
		log(`  标题变体 ${title}: ${[...set].join(' / ')}`);
	};

	// 批量转换：多行标题一次 parse，每个变体只发一次请求，输出按行 1:1 对应；返回 false 表示需退化为逐个转换
	const convertBatch = async (batch: string[]): Promise<boolean> => {
		const sets = new Map<string, Set<string>>(batch.map((key): [string, Set<string>] => [key, new Set<string>([key])]));
		for (const variant of ZH_VARIANTS) {
			try {
				const { data } = await api.post<ApiParseResponse>({
					action: 'parse',
					text: batch.join('\n'),
					contentmodel: 'wikitext',
					variant,
					prop: 'text',
				}, {
					retry: 15,
				} as any);
				const html: string | undefined = data?.parse?.text;
				const paragraph = typeof html === 'string' ? extractFirstParagraph(html) : null;
				if (paragraph === null) return false;
				const lines = htmlToText(paragraph).split(/\r?\n/);
				// 行数不齐说明发生了意料外的块级解析，批量结果不可信
				if (lines.length !== batch.length) return false;
				for (const [i, key] of batch.entries()) {
					const converted = lines[i]?.trim();
					if (converted) sets.get(key)!.add(normalizeTitle(converted));
				}
			} catch {
				return false;
			}
			await sleep(300);
		}
		for (const [key, set] of sets) {
			titleVariantCache.set(key, set);
			log(`  标题变体 ${key}: ${[...set].join(' / ')}`);
		}
		return true;
	};

	const unsafe = titles.filter((title) => UNSAFE_LINE_START.test(title));
	for (const title of unsafe) await convertOne(title);
	const safe = titles.filter((title) => !UNSAFE_LINE_START.test(title));
	for (let i = 0; i < safe.length; i += BATCH_VARIANT_SIZE) {
		const batch = safe.slice(i, i + BATCH_VARIANT_SIZE);
		if (!await convertBatch(batch)) {
			log('  批量变体转换未通过，本批退化为逐个转换');
			for (const title of batch) await convertOne(title);
		}
	}
}

/** 显示文字是否与指定标题实际相同（完全一致或仅繁简不同） */
function displayMatchesTitle(display: string, title: string): boolean {
	const set = titleVariantCache.get(normalizeTitle(title));
	if (set) return set.has(normalizeTitle(display));
	return normalizeTitle(display) === normalizeTitle(title);
}

/** 显示文字是否与旧/新标题实际相同（冗余管道的判定依据；只比较标题部分，忽略锚点） */
function displayMatchesRule(display: string, rule: PreparedRule): boolean {
	return displayMatchesTitle(display, rule.fromTitle) || displayMatchesTitle(display, rule.toTitle);
}

/**
 * 显示文字是否为标题剥去紧贴的半角括号后缀（如 苹果(植物) 的显示 苹果）。
 * 只识别站规规定的紧贴半角括号，空格/全角括号不处理，避免误伤原文。
 */
function displayHidesSuffix(display: string, title: string): boolean {
	const d = normalizeTitle(display);
	if (!d) return false;
	const variants = titleVariantCache.get(normalizeTitle(title));
	if (!variants) return false;
	for (const variant of variants) {
		// 末尾必须是单个不含内层括号的 (…) 组，避免 A(B)C) 之类的整串比较误判
		const match = /^(.*)\(([^()]*)\)$/.exec(variant);
		if (match !== null && match[1] === d) return true;
	}
	return false;
}

/**
 * 显示文字是否属于"标题型"：与旧/新标题实际相同；消歧义页上还含仅隐藏了紧贴半角括号后缀的显示。
 * 空显示（管道魔术 [[X|]] 会隐去命名空间前缀与括号后缀）在消歧义页上同样视为标题型。
 */
function isTitleDisplay(display: string, rule: PreparedRule, isDisambiguation: boolean): boolean {
	if (!isDisambiguation) return displayMatchesRule(display, rule);
	if (display.trim() === '') return true;
	return displayMatchesRule(display, rule)
		|| displayHidesSuffix(display, rule.fromTitle)
		|| displayHidesSuffix(display, rule.toTitle);
}

/** 模板名归一化：命名空间前缀小写、主体按 normalizeTitle 处理 */
function normalizeTemplateName(name: string): string {
	const colon = name.indexOf(':');
	if (colon === -1) return normalizeTitle(name);
	return `${name.slice(0, colon).replace(/_/g, ' ').trim().toLowerCase()}:${normalizeTitle(name.slice(colon + 1))}`;
}

function splitFragment(title: string): [string, string | undefined] {
	const idx = title.indexOf('#');
	if (idx === -1) return [title, undefined];
	return [title.slice(0, idx), title.slice(idx + 1)];
}

/**
 * 锚点归一化：空白/下划线的连续序列折叠为单个下划线，并去掉尾部下划线。
 * 与 wikiparser-node 输出的 fragment 保持一致（如 "历  史"、"历_ _史" 归为 "历_史"，"历史_" 归为 "历史"）。
 * 锚点对繁简敏感，故此处不做任何变体转换。
 */
function normAnchor(anchor: string): string {
	return anchor.replace(/[\s_]+/g, '_').replace(/_+$/, '');
}

/** exact 索引的键：`归一化标题#归一化锚点`（构造侧与查询侧共用，键格式只在此处定义） */
function exactKey(title: string, anchor: string): string {
	return `${normalizeTitle(title)}#${normAnchor(anchor)}`;
}

/** 预解析后的规则：from/to 的标题与锚点各拆分一次，各消费点直接读字段 */
interface PreparedRule extends ReplacementRule {
	fromTitle: string;
	fromFrag?: string;
	toTitle: string;
	toFrag?: string;
}

function prepareRule(rule: ReplacementRule): PreparedRule {
	const [fromTitle, fromFrag] = splitFragment(rule.from);
	const [toTitle, toFrag] = splitFragment(rule.to);
	return { ...rule, fromTitle, fromFrag, toTitle, toFrag };
}

/**
 * 规则索引：exact 存 from 含锚点的规则（键 `标题#锚点`），title 存 from 无锚点的规则（键 `标题`）；
 * transclusions 存 from 含命名空间前缀（可作模板嵌入引用）的规则（键为模板名归一化）。
 */
interface RuleIndex {
	exact: Map<string, PreparedRule>;
	title: Map<string, PreparedRule>;
	transclusions: Map<string, PreparedRule>;
}

function buildRuleIndex(rules: PreparedRule[]): RuleIndex {
	const index: RuleIndex = { exact: new Map(), title: new Map(), transclusions: new Map() };
	for (const rule of rules) {
		if (rule.fromFrag !== undefined) {
			index.exact.set(exactKey(rule.fromTitle, rule.fromFrag), rule);
		} else {
			index.title.set(normalizeTitle(rule.fromTitle), rule);
		}
		const fromNorm = normalizeTemplateName(rule.from);
		if (fromNorm.includes(':')) index.transclusions.set(fromNorm, rule);
	}
	return index;
}

/** 按 标题/锚点 查规则：含锚点的精确键优先于纯标题键 */
function lookupRule(index: RuleIndex, title: string, fragment: string | undefined): PreparedRule | undefined {
	if (fragment !== undefined) {
		const exact = index.exact.get(exactKey(title, fragment));
		if (exact) return exact;
	}
	return index.title.get(normalizeTitle(title));
}

/**
 * 生成新链接目标。from 与 to 均不含锚点时保留链接原锚点（现有行为）；
 * 其余任一含锚点时一律取 to 逐字（可新增、改写或去除锚点）。
 * hasFragment 表示新目标是否带锚点，供调用方决定显示文字的写法。
 */
function buildTarget(rule: PreparedRule, linkFragment: string | undefined): { target: string; hasFragment: boolean } {
	if (rule.fromFrag === undefined && rule.toFrag === undefined) {
		return linkFragment
			? { target: `${rule.toTitle}#${linkFragment}`, hasFragment: true }
			: { target: rule.toTitle, hasFragment: false };
	}
	return { target: rule.to, hasFragment: rule.toFrag !== undefined };
}

/** hits 统计键 */
function hitKey(rule: ReplacementRule): string {
	return `${rule.from}→${rule.to}`;
}

function escapeCharClass(chars: string): string {
	return chars.replace(/[\\\]^-]/g, '\\$&');
}

/**
 * AbuseFilter 分类：萌百的 warn 类过滤器在同一会话内记录"已警告"标记，
 * 重新提交一次即可通过；disallowed 是硬拒绝。判定来源包括 200 响应体与抛出的错误对象。
 */
function classifyAbuseFilter(sources: unknown[]): 'retry' | 'disallowed' | 'none' {
	const text = sources
		.filter(Boolean)
		.map((s) => (s instanceof Error ? `${s.message}:${JSON.stringify((s as { cause?: unknown }).cause ?? '')}` : JSON.stringify(s)))
		.join('\n');
	const codes: string[] = text.match(/abusefilter-[\w-]+/g) ?? [];
	if (codes.includes('abusefilter-disallowed')) return 'disallowed';
	return codes.length > 0 ? 'retry' : 'none';
}

/**
 * 对单个模板参数值执行一条替换规则。
 * 返回新值与命中的规则；未命中返回 null。参数值中的裸 | 会破坏模板结构，统一转义为 {{!}}。
 */
function replaceParamValue(raw: string, index: RuleIndex, separator: string | undefined, isDisambiguation: boolean): { value: string; rule: PreparedRule } | null {
	const normalized = raw.replace(/\{\{!\}\}/g, '|');
	const firstSep = separator ? new RegExp(`[${escapeCharClass(separator)}]`) : null;
	const match = firstSep ? firstSep.exec(normalized) : null;
	const targetRaw = match ? normalized.slice(0, match.index) : normalized;
	const tail = match ? normalized.slice(match.index) : '';
	const [main, fragment] = splitFragment(targetRaw.trim());
	const rule = lookupRule(index, main, fragment);
	if (!rule) return null;
	const { target, hasFragment } = buildTarget(rule, fragment);
	let result = target;
	if (match && separator) {
		const pieces = tail.split(new RegExp(`([${escapeCharClass(separator)}])`));
		// pieces: ['', 分隔符, 分段, 分隔符, 分段, ...]，分段位于偶数下标（≥2）
		const displaySegCount = (pieces.length - 1) / 2;
		const matchedCount = pieces.filter((seg, i) => i >= 2 && i % 2 === 0 && isTitleDisplay(seg, rule, isDisambiguation)).length;
		// 纯管道显示尾部（如大家族内容行）且新目标无锚点：显示与旧/新标题实际相同时整体移除冗余管道
		if (separator.includes('|') && !hasFragment && displaySegCount > 0 && matchedCount === displaySegCount) {
			return { value: result.replace(/\|/g, '{{!}}'), rule };
		}
		// 其余分段：与旧/新标题实际相同时同步为新标题（含锚点的目标只取标题部分，避免锚点暴露）
		for (let i = 2; i < pieces.length; i += 2) {
			if (pieces[i] !== undefined && isTitleDisplay(pieces[i], rule, isDisambiguation)) {
				pieces[i] = rule.toTitle;
			}
		}
		result += pieces.join('');
	}
	return { value: result.replace(/\|/g, '{{!}}'), rule };
}

/** 直接内链 [[旧标题]] / [[旧标题|显示]] / [[旧标题#锚点]] */
function replaceDirectLinks(parsed: Parser.Token, index: RuleIndex, hits: Map<string, number>, isDisambiguation: boolean): void {
	const links = parsed.querySelectorAll<Parser.LinkToken>('link');
	for (const link of links) {
		const rule = lookupRule(index, link.link.title, link.link.fragment);
		if (!rule) continue;
		const hasPipe = link.childNodes.length === 2;
		const { target, hasFragment } = buildTarget(rule, link.link.fragment);
		link.link = target;
		if (hasPipe && isTitleDisplay(link.innerText, rule, isDisambiguation)) {
			if (hasFragment) {
				// 目标带锚点时无管道写法会把锚点显示出来，保留管道并显示新标题
				link.innerText = rule.toTitle;
			} else {
				// 显示与旧/新标题实际相同：移除冗余管道符
				(link.childNodes as unknown as readonly Parser.Token[])[1]?.remove();
			}
		}
		const key = hitKey(rule);
		hits.set(key, (hits.get(key) ?? 0) + 1);
	}
}

/**
 * 文件链接（[[File:…|link=目标]]、gallery/imagemap 图片）的 link 参数。
 * link=（空值，禁用链接）不参与替换；caption 与旧/新标题实际相同时同步为新标题。
 */
function replaceFileLinks(parsed: Parser.Token, index: RuleIndex, hits: Map<string, number>, isDisambiguation: boolean): void {
	const files = parsed.querySelectorAll<Parser.FileToken>('file, gallery-image, imagemap-image');
	for (const file of files) {
		const raw = file.getValue('link');
		if (typeof raw !== 'string' || raw === '') continue;
		const [main, fragment] = splitFragment(raw.trim());
		const rule = lookupRule(index, main, fragment);
		if (!rule) continue;
		file.setValue('link', buildTarget(rule, fragment).target);
		// 消歧义页的 caption 是描述文字而非义项名，保持原样
		if (!isDisambiguation) {
			const caption = file.getValue('caption');
			if (typeof caption === 'string' && displayMatchesRule(caption.trim(), rule)) {
				file.setValue('caption', rule.toTitle);
			}
		}
		const key = hitKey(rule);
		hits.set(key, (hits.get(key) ?? 0) + 1);
	}
}

/** 配置的链接模板（Coloredlink 等）的目标参数与显示文字参数 */
function replaceTemplateArgs(parsed: Parser.Token, templateMap: Map<string, LinkTemplateConfig>, index: RuleIndex, hits: Map<string, number>, isDisambiguation: boolean): void {
	const templates = parsed.querySelectorAll<Parser.TranscludeToken>('template');
	for (const temp of templates) {
		const cfg = templateMap.get(normalizeTemplateName(temp.name));
		if (!cfg) continue;
		const applyRule = (key: string): PreparedRule | null => {
			const raw = temp.getValue(key);
			if (raw === undefined) return null;
			const next = replaceParamValue(raw, index, cfg.valueSeparator, isDisambiguation);
			if (next === null || next.value === raw) return null;
			temp.setValue(key, next.value);
			const statKey = hitKey(next.rule);
			hits.set(statKey, (hits.get(statKey) ?? 0) + 1);
			return next.rule;
		};
		let matchedRule: PreparedRule | null = null;
		let matchedTargetKey: string | null = null;
		if (cfg.param === 'all') {
			for (const arg of temp.getAllArgs()) {
				if (!/^\d+$/.test(arg.name)) continue;
				const rule = applyRule(arg.name);
				if (rule) {
					matchedRule = rule;
					matchedTargetKey = arg.name;
				}
			}
		} else {
			const candidates = (Array.isArray(cfg.param) ? cfg.param : [cfg.param]).map(String);
			for (const key of candidates) {
				const raw = temp.getValue(key);
				if (raw === undefined || raw.trim() === '') continue;
				const rule = applyRule(key);
				if (rule) {
					matchedRule = rule;
					matchedTargetKey = key;
				}
				break; // 只取首个非空候选参数
			}
		}
		if (matchedRule && cfg.displayParam !== undefined) {
			const displayKey = String(cfg.displayParam);
			const displayRaw = temp.getValue(displayKey);
			if (displayRaw !== undefined && isTitleDisplay(displayRaw.trim(), matchedRule, isDisambiguation)) {
				const targetRaw = matchedTargetKey !== null ? temp.getValue(matchedTargetKey) : undefined;
				if (typeof targetRaw === 'string' && targetRaw.includes('#')) {
					// 目标带锚点：移除显示参数会把锚点暴露到显示文字，改为显式设为新标题（新#锚点|新）
					temp.setValue(displayKey, matchedRule.toTitle);
				} else {
					// 显示与旧/新标题实际相同：移除冗余显示参数
					temp.removeArg(displayKey);
				}
			}
		}
	}
}

/** 普通嵌入引用 {{Template:旧}}：仅当规则 from 带模板命名空间前缀时重写，避免误伤主命名空间规则 */
function renameTransclusions(parsed: Parser.Token, index: RuleIndex, hits: Map<string, number>): void {
	const templates = parsed.querySelectorAll<Parser.TranscludeToken>('template');
	for (const temp of templates) {
		const rule = index.transclusions.get(normalizeTemplateName(temp.name));
		if (!rule) continue;
		temp.replaceTemplate(rule.to.replace(/^template:/i, ''));
		const key = hitKey(rule);
		hits.set(key, (hits.get(key) ?? 0) + 1);
	}
}

async function fetchJsonConfig(pageTitle: string): Promise<BotConfig> {
	const content = await fetchPageContent(pageTitle);
	if (content === null) {
		throw new Error(`配置页面 "${pageTitle}" 不存在或无法获取内容`);
	}
	try {
		return JSON.parse(content) as BotConfig;
	} catch (e) {
		throw new Error(`JSON解析失败: ${(e as Error).message}`, { cause: e });
	}
}

/** 取页面正文、是否为消歧义页（pageprops.disambiguation）与当前版本号 */
async function fetchPageData(title: string): Promise<{ content: string | null; isDisambiguation: boolean; revid: number | null }> {
	const { data } = await api.post<ApiQueryResponse>({
		action: 'query',
		prop: 'revisions|pageprops',
		rvprop: 'ids|content',
		titles: title,
	}, {
		retry: 15,
	} as any);

	const pages = data.query?.pages;
	const page = pages ? Object.values(pages)[0] : undefined;
	const content = page?.revisions?.[0]?.content ?? null;
	const isDisambiguation = page?.pageprops !== undefined && 'disambiguation' in page.pageprops;
	const revid = typeof page?.revisions?.[0]?.revid === 'number' ? page.revisions[0].revid : null;
	return { content, isDisambiguation, revid };
}

async function fetchPageContent(title: string): Promise<string | null> {
	return (await fetchPageData(title)).content;
}

async function buildTemplateMap(linkTemplates: LinkTemplateConfig[] | undefined): Promise<Map<string, LinkTemplateConfig>> {
	if (!linkTemplates?.length) return new Map();
	const withFull = linkTemplates.map((t) => ({
		...t,
		templateName: t.name.includes(':') ? t.name : `Template:${t.name}`,
	}));
	const rawMap = await buildTemplateNameMap(api, withFull);
	const map = new Map<string, LinkTemplateConfig>();
	for (const [key, value] of rawMap) {
		map.set(normalizeTemplateName(key), value);
	}
	return map;
}

function validateConfig(cfg: BotConfig): string | null {
	if (!Array.isArray(cfg.replacements) || cfg.replacements.length === 0) return 'replacements 不能为空';
	if (cfg.mode !== undefined && !['replace', 'move'].includes(cfg.mode)) return 'mode 只能是 replace 或 move';
	for (const [i, rule] of cfg.replacements.entries()) {
		if (!rule.from || !rule.to) return `replacements[${i}] 缺少 from 或 to`;
		// 含锚点的规则要求标题部分非空（纯锚点规则无意义）
		if (rule.from.trim().startsWith('#')) return `replacements[${i}] from 的标题部分不能为空（不支持纯锚点规则）`;
		if (rule.to.trim().startsWith('#')) return `replacements[${i}] to 的标题部分不能为空`;
		if (normalizeTitle(rule.from) === normalizeTitle(rule.to)) return `replacements[${i}] from 与 to 相同`;
	}
	if (cfg.namespaces !== undefined && (!Array.isArray(cfg.namespaces) || cfg.namespaces.some((n) => !Number.isInteger(n) || n < 0))) {
		return 'namespaces 必须是非负整数数组';
	}
	if (cfg.pages !== undefined && !Array.isArray(cfg.pages)) return 'pages 必须是字符串数组';
	if (!cfg.pages?.length && !cfg.namespaces?.length) return '必须提供 pages 或 namespaces 至少一种页面来源';
	return null;
}

/** 检查 from 的移动前置状态：已是 to 的重定向 / 不存在 / 正常存在 */
async function checkMoveState(from: string, to: string): Promise<'redirected' | 'missing' | 'exists'> {
	// 注意：带 redirects=1 时 MediaWiki 会把 pages 数组中的重定向条目替换为其指向的
	// 最终页面，因此不能直接用 pages[0].missing 判断 from 是否存在——当 from 是指向
	// 缺失页的重定向时会被误判为 missing。故 missing 判定须锚定 from 原标题。
	const { data } = await api.post<ApiQueryResponse>({
		action: 'query',
		format: 'json',
		formatversion: '2',
		titles: from,
		prop: 'info',
		redirects: 1,
	}, {
		retry: 15,
	} as any);

	const pages = data?.query?.pages ?? [];
	if (!Array.isArray(pages)) return 'exists';
	const missingSelf = pages.some((p: { title?: string; missing?: boolean }) => p.missing && normalizeTitle(p.title ?? '') === normalizeTitle(from));
	if (missingSelf) return 'missing';
	const redirects = data?.query?.redirects ?? [];
	if (redirects.some((r) => normalizeTitle(r.from as string) === normalizeTitle(from) && normalizeTitle(r.to as string) === normalizeTitle(to))) {
		return 'redirected';
	}
	return 'exists';
}

async function attemptMove(params: MwApiParams): Promise<{ ok: boolean; code?: string; info?: string }> {
	try {
		const { data } = await api.postWithToken<ApiMoveResponse>('csrf', params, {
			retry: 3,
			noCache: true,
		} as any);
		// moderation-*-queued 是 error 形态的成功响应，必须在 extractApiError 判失败之前处理
		if (data?.move) return { ok: true };
		if (checkModerationQueued(data, '移动请求已进入审核队列（视为成功）')) return { ok: true };
		const apiError = extractApiError(data);
		if (apiError) return { ok: false, ...apiError };
		return { ok: false, code: 'unexpected-response', info: JSON.stringify(data) };
	} catch (error) {
		const err = error as Error;
		if (isPermissionDeniedError(err)) throw err;
		if (checkModerationQueuedError(err, '移动已进入审核队列')) return { ok: true };
		return { ok: false, code: 'exception', info: err.message };
	}
}

/** 移动阶段：返回移动成功（或视为已完成）的规则，失败的规则本轮不参与链接替换 */
async function runMovePhase(cfg: BotConfig, summary: string, interval: number, dryRun: boolean, log: (msg: string) => void, emit: EmitProgress): Promise<PreparedRule[]> {
	const moveCfg = cfg.move ?? {};
	const applicable: PreparedRule[] = [];
	console.log(`== 移动阶段（${cfg.replacements.length} 条规则） ==`);
	for (const raw of cfg.replacements) {
		const rule = prepareRule(raw);
		if (rule.fromFrag !== undefined) {
			// 锚点规则不涉及页面移动，直接参与链接替换
			log(`  ${rule.from} → ${rule.to}：锚点规则，跳过移动`);
			applicable.push(rule);
			continue;
		}
		const state = await checkMoveState(rule.fromTitle, rule.toTitle);
		if (state === 'redirected') {
			log(`  ${rule.fromTitle} 已是 ${rule.toTitle} 的重定向，跳过移动`);
			emit({ type: 'edit', title: rule.fromTitle, status: 'skipped', oldRevid: null, newRevid: null, message: `已是 ${rule.toTitle} 的重定向` });
			applicable.push(rule);
		} else if (state === 'missing') {
			log(`  ${rule.fromTitle} 不存在，视为已完成移动`);
			emit({ type: 'edit', title: rule.fromTitle, status: 'skipped', oldRevid: null, newRevid: null, message: '页面不存在，视为已完成移动' });
			applicable.push(rule);
		} else if (dryRun) {
			log(`  [DRY-RUN] 将移动 ${rule.fromTitle} → ${rule.toTitle}`);
			emit({ type: 'edit', title: rule.fromTitle, status: 'changed', oldRevid: null, newRevid: null, message: `[DRY-RUN] 移动到 ${rule.toTitle}` });
			applicable.push(rule);
		} else {
			const params: MwApiParams = {
				action: 'move',
				format: 'json',
				formatversion: '2',
				from: rule.fromTitle,
				to: rule.toTitle,
				reason: summary,
				movetalk: moveCfg.movetalk !== false,
				movesubpages: true,
				tags: 'Bot',
			};
			if (moveCfg.noredirect) params.noredirect = 1;
			let result = await attemptMove(params);
			if (!result.ok && moveCfg.noredirect && /suppressredirect|noredirect/i.test(`${result.code ?? ''} ${result.info ?? ''}`)) {
				log(`  ${rule.fromTitle}：不留重定向失败（${result.code}），降级为保留重定向`);
				delete params.noredirect;
				result = await attemptMove(params);
			}
			if (!result.ok && result.code === 'tags-apply-not-allowed') {
				delete params.tags;
				result = await attemptMove(params);
			}
			if (result.ok) {
				log(`  已移动 ${rule.fromTitle} → ${rule.toTitle}`);
				emit({ type: 'edit', title: rule.fromTitle, status: 'changed', oldRevid: null, newRevid: null, message: `已移动到 ${rule.toTitle}` });
				applicable.push(rule);
			} else {
				console.error(`  移动失败 ${rule.fromTitle} → ${rule.toTitle}: [${result.code}] ${result.info}（该规则本轮不执行链接替换）`);
				emit({ type: 'edit', title: rule.fromTitle, status: 'failed', oldRevid: null, newRevid: null, message: `移动失败：[${result.code}] ${result.info}` });
			}
		}
		await sleep(interval);
	}
	return applicable;
}

/** 发现阶段：显式 pages ∪ 各 from 的链入（backlinks）∪ 嵌入引用（embeddedin），均在指定命名空间内 */
async function discoverPages(cfg: BotConfig, applicableRules: PreparedRule[], log: (msg: string) => void): Promise<string[]> {
	const found = new Set<string>();
	for (const page of cfg.pages ?? []) {
		if (page.trim()) found.add(page.trim());
	}
	const namespaces = cfg.namespaces;
	if (!namespaces?.length) return [...found];
	const nsParam = namespaces.join('|');
	// 同一标题的多条规则（含锚点规则）只需查询一次链入/嵌入
	const queryTitles = [...new Set(applicableRules.map((rule) => rule.fromTitle))];
	for (const queryTitle of queryTitles) {
		let blcontinue: string | undefined;
		do {
			const { data } = await api.post<ApiQueryResponse>({
				action: 'query',
				list: 'backlinks',
				bltitle: queryTitle,
				blnamespace: nsParam,
				bllimit: 'max',
				blcontinue,
			}, {
				retry: 15,
			} as any);
			for (const bl of data.query?.backlinks ?? []) {
				found.add(bl.title);
			}
			blcontinue = data.continue?.blcontinue;
			if (blcontinue) await sleep(1000);
		} while (blcontinue);

		let eicontinue: string | undefined;
		do {
			const { data } = await api.post<ApiQueryResponse>({
				action: 'query',
				list: 'embeddedin',
				eititle: queryTitle,
				einnamespace: nsParam,
				eilimit: 'max',
				eicontinue,
			}, {
				retry: 15,
			} as any);
			for (const ei of data.query?.embeddedin ?? []) {
				found.add(ei.title);
			}
			eicontinue = data.continue?.eicontinue;
			if (eicontinue) await sleep(1000);
		} while (eicontinue);
	}
	log(`发现阶段完成，共 ${found.size} 个待处理页面`);
	return [...found].sort();
}

async function attemptEdit(params: MwApiParams): Promise<{ data: ApiEditResponse | null; thrown: Error | null }> {
	try {
		const { data } = await api.postWithEditToken<ApiEditResponse>(params);
		return { data, thrown: null };
	} catch (error) {
		return { data: null, thrown: error as Error };
	}
}

async function submitEdit(title: string, text: string, summary: string, log: (msg: string) => void): Promise<number | null> {
	const params = {
		action: 'edit',
		title,
		text,
		summary,
		bot: true,
		minor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	};
	let { data, thrown } = await attemptEdit(params);
	let classification = classifyAbuseFilter([data, thrown]);
	if (classification === 'retry') {
		log('  AbuseFilter 警告，同会话重试一次');
		({ data, thrown } = await attemptEdit(params));
		classification = classifyAbuseFilter([data, thrown]);
	}
	if (classification !== 'none') {
		throw new Error(`AbuseFilter ${classification === 'disallowed' ? '拒绝编辑' : '警告重试后仍未通过'}: ${data ? JSON.stringify(data) : thrown?.message}`);
	}
	if (thrown) throw thrown;
	// moderation-*-queued 是 error 形态的成功响应，必须在 extractApiError 判失败之前处理
	if (checkModerationQueued(data, '  编辑请求已进入审核队列（视为成功）')) return null;
	const apiError = extractApiError(data);
	if (apiError) throw new Error(`[${apiError.code}] ${apiError.info}`);
	if (data?.edit?.result !== 'Success') {
		throw new Error(`编辑响应异常: ${JSON.stringify(data)}`);
	}
	return typeof data.edit.newrevid === 'number' ? data.edit.newrevid : null;
}

async function processPage(
	title: string,
	index: RuleIndex,
	templateMap: Map<string, LinkTemplateConfig>,
	summary: string,
	dryRun: boolean,
	log: (msg: string) => void,
): Promise<{ hits: Map<string, number>; oldRevid: number | null; newRevid: number | null }> {
	const { content, isDisambiguation, revid } = await fetchPageData(title);
	if (content === null) {
		throw new Error('页面不存在或无法获取内容');
	}
	const parsed = Parser.parse(content);
	const hits = new Map<string, number>();
	replaceDirectLinks(parsed, index, hits, isDisambiguation);
	replaceFileLinks(parsed, index, hits, isDisambiguation);
	replaceTemplateArgs(parsed, templateMap, index, hits, isDisambiguation);
	renameTransclusions(parsed, index, hits);
	const newContent = parsed.toString();
	if (newContent === content) return { hits, oldRevid: revid, newRevid: revid };
	if (dryRun) {
		log('  [DRY-RUN] 将提交编辑');
		return { hits, oldRevid: revid, newRevid: null };
	}
	const newRevid = await submitEdit(title, newContent, summary, log);
	return { hits, oldRevid: revid, newRevid };
}

function parseArgs(args: string[]): CliArgs | null {
	const result: CliArgs = { configPage: '', dryRun: false, quiet: false, interval: 1500, reset: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') result.dryRun = true;
		else if (arg === '--quiet') result.quiet = true;
		else if (arg === '--reset') result.reset = true;
		else if (arg === '--interval' && args[i + 1]) {
			result.interval = parseInt(args[i + 1], 10);
			i++;
		} else if (arg === '--summary' && args[i + 1]) {
			result.summary = args[i + 1];
			i++;
		} else if (!arg.startsWith('-')) {
			result.configPage = arg;
		}
	}
	if (!result.configPage) {
		console.error(USAGE);
		return null;
	}
	if (!Number.isFinite(result.interval) || result.interval < 0) {
		console.error('--interval 必须是非负整数');
		return null;
	}
	return result;
}

function configFingerprint(cfg: BotConfig): string {
	return createHash('sha256').update(JSON.stringify({
		mode: cfg.mode ?? 'replace',
		namespaces: cfg.namespaces ?? [],
		move: cfg.move ?? {},
		linkTemplates: cfg.linkTemplates ?? [],
		replacements: cfg.replacements,
	})).digest('hex');
}

function loadCheckpoint(configPage: string, fingerprint: string, cliArgs: CliArgs): Checkpoint {
	if (cliArgs.dryRun) return { configPage, fingerprint, completed: [], failed: {} };
	const file = CHECKPOINT_FILE(configPage);
	if (cliArgs.reset && existsSync(file)) {
		rmSync(file);
		console.log('已清除 checkpoint');
	}
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Checkpoint;
			if (parsed.configPage === configPage && parsed.fingerprint === fingerprint) {
				console.log(`续跑：checkpoint 中已完成 ${parsed.completed.length} 页，将跳过`);
				return parsed;
			}
			console.log('配置指纹变化，作废旧 checkpoint，重新开始');
		} catch {
			console.log('checkpoint 损坏，重新开始');
		}
	}
	return { configPage, fingerprint, completed: [], failed: {} };
}

function saveCheckpoint(checkpoint: Checkpoint): void {
	if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true });
	writeFileSync(CHECKPOINT_FILE(checkpoint.configPage), JSON.stringify(checkpoint, null, 2), 'utf-8');
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const cliArgs = parseArgs(process.argv.slice(2));
	if (!cliArgs) process.exit(1);
	const emit = createEmitter(process.argv.includes('--progress-json'));
	emit({ type: 'start', task: '链接替换' });
	const verbose = !cliArgs.quiet;
	const log = (msg: string) => {
		if (verbose) console.log(msg);
	};
	try {
		await clientlogin(api, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!);

		const cfg = await fetchJsonConfig(cliArgs.configPage);
		const validationError = validateConfig(cfg);
		if (validationError) throw new Error(`配置校验失败: ${validationError}`);
		const mode = cfg.mode ?? 'replace';
		const summary = cliArgs.summary ?? DEFAULT_SUMMARY;
		log(`模式: ${mode}，规则 ${cfg.replacements.length} 条，命名空间过滤: ${cfg.namespaces?.length ? cfg.namespaces.join('|') : '无'}`);

		const templateMap = await buildTemplateMap(cfg.linkTemplates);
		if (templateMap.size > 0) log(`链接模板配置 ${cfg.linkTemplates!.length} 项（含重定向共 ${templateMap.size} 个模板名）`);

		if (mode === 'move') emit({ type: 'phase', name: '移动阶段' });
		const applicableRules: PreparedRule[] = mode === 'move'
			? await runMovePhase(cfg, summary, cliArgs.interval, cliArgs.dryRun, log, emit)
			: cfg.replacements.map(prepareRule);
		if (applicableRules.length === 0) {
			console.log('没有可用的替换规则（全部移动失败），结束');
			process.exit(1);
		}
		const index = buildRuleIndex(applicableRules);
		// 变体转换与页面发现互不依赖（变体集合要到逐页处理时才被读取），并行执行
		const [, pages] = await Promise.all([buildTitleVariants(applicableRules, log), discoverPages(cfg, applicableRules, log)]);
		if (pages.length === 0) {
			console.log('没有发现待处理页面，结束');
			process.exit(0);
		}
		log(`待处理页面共 ${pages.length} 个`);

		emit({ type: 'phase', name: '替换阶段' });
		const checkpoint = loadCheckpoint(cliArgs.configPage, configFingerprint(cfg), cliArgs);
		let changed = 0;
		let unchanged = 0;
		let failed = 0;
		for (const title of pages) {
			if (checkpoint.completed.includes(title)) {
				log(`跳过（checkpoint 已完成）: ${title}`);
				emit({ type: 'edit', title, status: 'skipped', oldRevid: null, newRevid: null, message: '续跑：checkpoint 已完成' });
				emit({ type: 'progress', done: Math.min(checkpoint.completed.length, pages.length), total: pages.length, message: '已处理' });
				continue;
			}
			try {
				const { hits, oldRevid, newRevid } = await processPage(title, index, templateMap, summary, cliArgs.dryRun, log);
				const detail = [...hits.entries()].map(([rule, count]) => `${rule} ${count} 处`).join('，');
				if (hits.size > 0) {
					log(`${title}: ${detail}`);
					changed++;
					emit({
						type: 'edit',
						title,
						status: 'changed',
						oldRevid,
						newRevid: cliArgs.dryRun ? null : newRevid,
						message: cliArgs.dryRun ? `[DRY-RUN] ${detail}` : detail,
					});
				} else {
					unchanged++;
					emit({ type: 'edit', title, status: 'skipped', oldRevid, newRevid: oldRevid, message: '无匹配' });
				}
				// 无论是否命中均标记完成：无命中页重跑也不会再命中
				checkpoint.completed.push(title);
				delete checkpoint.failed[title];
			} catch (error) {
				const err = error as Error;
				if (isPermissionDeniedError(err)) {
					console.error('权限不足，终止');
					process.exit(1);
				}
				console.error(`处理失败 ${title}: ${err.message}`);
				emit({ type: 'edit', title, status: 'failed', oldRevid: null, newRevid: null, message: err.message });
				checkpoint.failed[title] = err.message;
				failed++;
			}
			emit({ type: 'progress', done: Math.min(checkpoint.completed.length, pages.length), total: pages.length, message: '已处理' });
			if (!cliArgs.dryRun) saveCheckpoint(checkpoint);
			await sleep(cliArgs.interval);
		}

		console.log(`\n汇总：修改 ${changed} 页，无变化 ${unchanged} 页，失败 ${failed} 页` +
			(mode === 'move' ? `，适用规则 ${applicableRules.length}/${cfg.replacements.length} 条` : '') +
			(cliArgs.dryRun ? '（dry-run，未提交任何编辑）' : ''));
		emit({ type: 'done', summary: { changed, skipped: unchanged, failed } });
		if (!cliArgs.dryRun && Object.keys(checkpoint.failed).length > 0) {
			console.log('失败页面（续跑将自动重试）:');
			for (const [title, message] of Object.entries(checkpoint.failed)) {
				console.log(`  ${title}: ${message}`);
			}
		}
	} catch (error) {
		const err = error as Error;
		console.error(`发生错误: ${err.name}: ${err.message}`);
		if (err.stack) console.error(err.stack);
		process.exit(1);
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();
