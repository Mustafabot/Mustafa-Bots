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

/** 每条规则 from 的繁简变体集合（含原标题），用于判定"显示文字与旧标题实际相同" */
const titleVariantCache = new Map<string, Set<string>>();

const ZH_VARIANTS = ['zh-cn', 'zh-hans', 'zh-hant', 'zh-tw', 'zh-hk'];

/** 从 action=parse 的 HTML 输出中提取纯文本 */
function extractParsedText(html: string): string {
	const pMatch = /<p>([\s\S]*?)<\/p>/.exec(html);
	const body = pMatch ? pMatch[1] : html;
	return body
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, "'")
		.trim();
}

/** 通过 API 把规则 from 转换为各繁简变体，建立变体集合（重复 from 只转换一次） */
async function buildTitleVariants(rules: ReplacementRule[], log: (msg: string) => void): Promise<void> {
	const seen = new Set<string>();
	for (const rule of rules) {
		const key = normalizeTitle(rule.from);
		if (seen.has(key)) continue;
		seen.add(key);
		const set = new Set<string>([key]);
		for (const variant of ZH_VARIANTS) {
			try {
				const { data } = await api.post({
					action: 'parse',
					text: rule.from,
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
		titleVariantCache.set(key, set);
		log(`  标题变体 ${rule.from}: ${[...set].join(' / ')}`);
	}
}

/** 显示文字是否与旧标题实际相同（完全一致或仅繁简不同） */
function displayMatchesRule(display: string, rule: ReplacementRule): boolean {
	const set = titleVariantCache.get(normalizeTitle(rule.from));
	if (set) return set.has(normalizeTitle(display));
	return normalizeTitle(display) === normalizeTitle(rule.from);
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
 * 返回新值；未命中返回 null。参数值中的裸 | 会破坏模板结构，统一转义为 {{!}}。
 */
function replaceParamValue(raw: string, rule: ReplacementRule, separator: string | undefined): string | null {
	const normalized = raw.replace(/\{\{!\}\}/g, '|');
	const firstSep = separator ? new RegExp(`[${escapeCharClass(separator)}]`) : null;
	const match = firstSep ? firstSep.exec(normalized) : null;
	const targetRaw = match ? normalized.slice(0, match.index) : normalized;
	const tail = match ? normalized.slice(match.index) : '';
	const [main, fragment] = splitFragment(targetRaw.trim());
	if (normalizeTitle(main) !== normalizeTitle(rule.from)) return null;
	let result = fragment ? `${rule.to}#${fragment}` : rule.to;
	if (match && separator) {
		const pieces = tail.split(new RegExp(`([${escapeCharClass(separator)}])`));
		// pieces: ['', 分隔符, 分段, 分隔符, 分段, ...]，分段位于偶数下标（≥2）
		const displaySegCount = (pieces.length - 1) / 2;
		const matchedCount = pieces.filter((seg, i) => i >= 2 && i % 2 === 0 && displayMatchesRule(seg, rule)).length;
		// 纯管道显示尾部（如大家族内容行）且目标无片段：显示与旧标题实际相同时整体移除冗余管道
		if (separator.includes('|') && !fragment && displaySegCount > 0 && matchedCount === displaySegCount) {
			return result.replace(/\|/g, '{{!}}');
		}
		// 其余分段：与旧标题实际相同时同步为新标题
		for (let i = 2; i < pieces.length; i += 2) {
			if (pieces[i] !== undefined && displayMatchesRule(pieces[i], rule)) {
				pieces[i] = rule.to;
			}
		}
		result += pieces.join('');
	}
	return result.replace(/\|/g, '{{!}}');
}

/** 直接内链 [[旧标题]] / [[旧标题|显示]] / [[旧标题#片段]] */
function replaceDirectLinks(parsed: Parser.Token, ruleMap: Map<string, ReplacementRule>, hits: Map<string, number>): void {
	const links = parsed.querySelectorAll<Parser.LinkToken>('link');
	for (const link of links) {
		const current = normalizeTitle(link.link.title);
		const rule = ruleMap.get(current);
		if (!rule) continue;
		const fragment = link.link.fragment;
		link.link = fragment ? `${rule.to}#${fragment}` : rule.to;
		if (link.childNodes.length === 2 && displayMatchesRule(link.innerText, rule)) {
			if (fragment) {
				// 有片段时无管道写法会把片段显示出来，保留管道并显示新标题
				link.innerText = rule.to;
			} else {
				// 显示与旧标题实际相同：移除冗余管道符
				(link.childNodes as unknown as readonly Parser.Token[])[1]?.remove();
			}
		}
		const key = `${rule.from}→${rule.to}`;
		hits.set(key, (hits.get(key) ?? 0) + 1);
	}
}

/** 配置的链接模板（Coloredlink 等）的目标参数与显示文字参数 */
function replaceTemplateArgs(parsed: Parser.Token, templateMap: Map<string, LinkTemplateConfig>, ruleMap: Map<string, ReplacementRule>, hits: Map<string, number>): void {
	const templates = parsed.querySelectorAll<Parser.TranscludeToken>('template');
	for (const temp of templates) {
		const cfg = templateMap.get(normalizeTemplateName(temp.name));
		if (!cfg) continue;
		const applyRule = (key: string, rule: ReplacementRule): boolean => {
			const raw = temp.getValue(key);
			if (raw === undefined) return false;
			const next = replaceParamValue(raw, rule, cfg.valueSeparator);
			if (next === null || next === raw) return false;
			temp.setValue(key, next);
			const hitKey = `${rule.from}→${rule.to}`;
			hits.set(hitKey, (hits.get(hitKey) ?? 0) + 1);
			return true;
		};
		let matchedRule: ReplacementRule | null = null;
		if (cfg.param === 'all') {
			for (const arg of temp.getAllArgs()) {
				if (!/^\d+$/.test(arg.name)) continue;
				for (const rule of ruleMap.values()) {
					if (applyRule(arg.name, rule)) {
						matchedRule = rule;
						break;
					}
				}
			}
		} else {
			const candidates = (Array.isArray(cfg.param) ? cfg.param : [cfg.param]).map(String);
			for (const key of candidates) {
				const raw = temp.getValue(key);
				if (raw === undefined || raw.trim() === '') continue;
				for (const rule of ruleMap.values()) {
					if (applyRule(key, rule)) {
						matchedRule = rule;
						break;
					}
				}
				break; // 只取首个非空候选参数
			}
		}
		if (matchedRule && cfg.displayParam !== undefined) {
			const displayKey = String(cfg.displayParam);
			const displayRaw = temp.getValue(displayKey);
			if (displayRaw !== undefined && displayMatchesRule(displayRaw.trim(), matchedRule)) {
				// 显示与旧标题实际相同：移除冗余显示参数
				temp.removeArg(displayKey);
			}
		}
	}
}

/** 普通嵌入引用 {{Template:旧}}：仅当规则 from 带模板命名空间前缀时重写，避免误伤主命名空间规则 */
function renameTransclusions(parsed: Parser.Token, ruleMap: Map<string, ReplacementRule>, hits: Map<string, number>): void {
	const templates = parsed.querySelectorAll<Parser.TranscludeToken>('template');
	for (const temp of templates) {
		const current = normalizeTemplateName(temp.name);
		for (const rule of ruleMap.values()) {
			const fromNorm = normalizeTemplateName(rule.from);
			if (!fromNorm.includes(':') || fromNorm !== current) continue;
			temp.replaceTemplate(rule.to.replace(/^template:/i, ''));
			const key = `${rule.from}→${rule.to}`;
			hits.set(key, (hits.get(key) ?? 0) + 1);
			break;
		}
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

async function fetchPageContent(title: string): Promise<string | null> {
	const { data } = await api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: title,
	}, {
		retry: 15,
	} as any);

	const pages = data.query?.pages as Record<string, { revisions?: Array<{ content: string }> }> | undefined;
	const page = pages ? Object.values(pages)[0] : undefined;
	if (!page?.revisions?.[0]) return null;
	return page.revisions[0].content;
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
	const { data } = await api.post({
		action: 'query',
		format: 'json',
		formatversion: '2',
		titles: from,
		redirects: 1,
	}, {
		retry: 15,
	} as any);

	const pages = data?.query?.pages ?? [];
	const page = Array.isArray(pages) ? pages[0] : undefined;
	if (page?.missing) return 'missing';
	const redirects = data?.query?.redirects ?? [];
	if (redirects.some((r: { from: string; to: string }) => normalizeTitle(r.from) === normalizeTitle(from) && normalizeTitle(r.to) === normalizeTitle(to))) {
		return 'redirected';
	}
	return 'exists';
}

async function attemptMove(params: Record<string, unknown>): Promise<{ ok: boolean; code?: string; info?: string }> {
	try {
		const { data } = await api.postWithToken('csrf', params as any, {
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
async function runMovePhase(cfg: BotConfig, summary: string, interval: number, dryRun: boolean, log: (msg: string) => void): Promise<ReplacementRule[]> {
	const moveCfg = cfg.move ?? {};
	const applicable: ReplacementRule[] = [];
	console.log(`== 移动阶段（${cfg.replacements.length} 条规则） ==`);
	for (const rule of cfg.replacements) {
		const state = await checkMoveState(rule.from, rule.to);
		if (state === 'redirected') {
			log(`  ${rule.from} 已是 ${rule.to} 的重定向，跳过移动`);
			applicable.push(rule);
		} else if (state === 'missing') {
			console.log(`  ${rule.from} 不存在，视为已完成移动`);
			applicable.push(rule);
		} else if (dryRun) {
			log(`  [DRY-RUN] 将移动 ${rule.from} → ${rule.to}`);
			applicable.push(rule);
		} else {
			const params: Record<string, unknown> = {
				action: 'move',
				format: 'json',
				formatversion: '2',
				from: rule.from,
				to: rule.to,
				reason: summary,
				movetalk: moveCfg.movetalk !== false,
				movesubpages: true,
				tags: 'Bot',
			};
			if (moveCfg.noredirect) params.noredirect = 1;
			let result = await attemptMove(params);
			if (!result.ok && moveCfg.noredirect && /suppressredirect|noredirect/i.test(`${result.code ?? ''} ${result.info ?? ''}`)) {
				log(`  ${rule.from}：不留重定向失败（${result.code}），降级为保留重定向`);
				delete params.noredirect;
				result = await attemptMove(params);
			}
			if (!result.ok && result.code === 'tags-apply-not-allowed') {
				delete params.tags;
				result = await attemptMove(params);
			}
			if (result.ok) {
				log(`  已移动 ${rule.from} → ${rule.to}`);
				applicable.push(rule);
			} else {
				console.error(`  移动失败 ${rule.from} → ${rule.to}: [${result.code}] ${result.info}（该规则本轮不执行链接替换）`);
			}
		}
		await sleep(interval);
	}
	return applicable;
}

/** 发现阶段：显式 pages ∪ 各 from 的链入（backlinks）∪ 嵌入引用（embeddedin），均在指定命名空间内 */
async function discoverPages(cfg: BotConfig, applicableRules: ReplacementRule[], log: (msg: string) => void): Promise<string[]> {
	const found = new Set<string>();
	for (const page of cfg.pages ?? []) {
		if (page.trim()) found.add(page.trim());
	}
	const namespaces = cfg.namespaces;
	if (!namespaces?.length) return [...found];
	const nsParam = namespaces.join('|');
	for (const rule of applicableRules) {
		let blcontinue: string | undefined;
		do {
			const { data } = await api.post({
				action: 'query',
				list: 'backlinks',
				bltitle: rule.from,
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
			const { data } = await api.post({
				action: 'query',
				list: 'embeddedin',
				eititle: rule.from,
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

async function attemptEdit(params: Record<string, unknown>): Promise<{ data: any; thrown: Error | null }> {
	try {
		const { data } = await api.postWithEditToken(params as any);
		return { data, thrown: null };
	} catch (error) {
		return { data: null, thrown: error as Error };
	}
}

async function submitEdit(title: string, text: string, summary: string, log: (msg: string) => void): Promise<void> {
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
	if (checkModerationQueued(data, '  编辑请求已进入审核队列（视为成功）')) return;
	const apiError = extractApiError(data);
	if (apiError) throw new Error(`[${apiError.code}] ${apiError.info}`);
	if (data?.edit?.result !== 'Success') {
		throw new Error(`编辑响应异常: ${JSON.stringify(data)}`);
	}
}

async function processPage(
	title: string,
	ruleMap: Map<string, ReplacementRule>,
	templateMap: Map<string, LinkTemplateConfig>,
	summary: string,
	dryRun: boolean,
	log: (msg: string) => void,
): Promise<Map<string, number>> {
	const content = await fetchPageContent(title);
	if (content === null) {
		throw new Error('页面不存在或无法获取内容');
	}
	const parsed = Parser.parse(content);
	const hits = new Map<string, number>();
	replaceDirectLinks(parsed, ruleMap, hits);
	replaceTemplateArgs(parsed, templateMap, ruleMap, hits);
	renameTransclusions(parsed, ruleMap, hits);
	const newContent = parsed.toString();
	if (newContent === content) return hits;
	if (dryRun) {
		log('  [DRY-RUN] 将提交编辑');
		return hits;
	}
	await submitEdit(title, newContent, summary, log);
	return hits;
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

		const applicableRules = mode === 'move'
			? await runMovePhase(cfg, summary, cliArgs.interval, cliArgs.dryRun, log)
			: cfg.replacements;
		if (applicableRules.length === 0) {
			console.log('没有可用的替换规则（全部移动失败），结束');
			process.exit(1);
		}
		const ruleMap = new Map<string, ReplacementRule>();
		for (const rule of applicableRules) {
			ruleMap.set(normalizeTitle(rule.from), rule);
		}
		await buildTitleVariants(applicableRules, log);

		const pages = await discoverPages(cfg, applicableRules, log);
		if (pages.length === 0) {
			console.log('没有发现待处理页面，结束');
			process.exit(0);
		}
		log(`待处理页面共 ${pages.length} 个`);

		const checkpoint = loadCheckpoint(cliArgs.configPage, configFingerprint(cfg), cliArgs);
		let changed = 0;
		let unchanged = 0;
		let failed = 0;
		for (const title of pages) {
			if (checkpoint.completed.includes(title)) {
				log(`跳过（checkpoint 已完成）: ${title}`);
				continue;
			}
			try {
				const hits = await processPage(title, ruleMap, templateMap, summary, cliArgs.dryRun, log);
				if (hits.size > 0) {
					console.log(`${title}: ${[...hits.entries()].map(([rule, count]) => `${rule} ${count} 处`).join('，')}`);
					changed++;
				} else {
					unchanged++;
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
				checkpoint.failed[title] = err.message;
				failed++;
			}
			if (!cliArgs.dryRun) saveCheckpoint(checkpoint);
			await sleep(cliArgs.interval);
		}

		console.log(`\n汇总：修改 ${changed} 页，无变化 ${unchanged} 页，失败 ${failed} 页` +
			(mode === 'move' ? `，适用规则 ${applicableRules.length}/${cfg.replacements.length} 条` : '') +
			(cliArgs.dryRun ? '（dry-run，未提交任何编辑）' : ''));
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
