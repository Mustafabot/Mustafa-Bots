import Parser from 'wikiparser-node';
import type { AstText } from 'wikiparser-node';
import type { MwApiParams } from 'wiki-saikou';
import type { ApiEditResponse, ApiQueryResponse } from 'types-mediawiki-response';
import { createZhApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { buildTemplateNameMap } from '../utils/templateRedirects.js';
import {
	checkModerationQueued,
	checkModerationQueuedError,
	extractApiError,
	isPermissionDeniedError,
} from '../utils/retry.js';

Parser.config = 'moegirl';

const PREFIX = '[UserboxCleanup]';
const USAGE = '用法: npx tsx src/cleanup/UserboxCleanup.ts [--dry-run] [--quiet] [--interval <ms>]';

/** 用户命名空间 */
const USER_NAMESPACE = 2;
/** ususers 批量查询的用户数上限 */
const USER_QUERY_BATCH = 50;
/** 默认编辑间隔（毫秒） */
const DEFAULT_INTERVAL = 1500;
/** 追踪「页面展示在根页面」时允许的嵌入层数上限（根页面 → 子页 → 子页的子页） */
const MAX_TRANSCLUSION_DEPTH = 3;

/**
 * 模板 → 合格用户的用户组（命中任一即视为仍持有权限）
 * 用户组取自 siteinfo 的 usergroups；延伸确认用户为显式组，与 bot 组无关
 */
interface UserboxRule {
	/** 模板名（不含 Template: 前缀） */
	template: string;
	/** 合格用户组 */
	groups: string[];
}

const RULES: UserboxRule[] = [
	{ template: '用户 管理员', groups: ['sysop'] },
	{ template: '用户 行政员', groups: ['bureaucrat'] },
	{ template: '用户 维护姬', groups: ['patroller'] },
	{ template: '用户 荣誉维护人员', groups: ['honoredmaintainer'] },
	{ template: '用户 优质编辑者', groups: ['goodeditor'] },
	{ template: '用户 优质编辑者2', groups: ['goodeditor'] },
	{ template: '用户 优质编辑者3', groups: ['goodeditor'] },
	{ template: '用户 STAFF', groups: ['staff'] },
	{ template: '用户 延伸确认用户', groups: ['extendedconfirmed'] },
];

interface CliArgs {
	dryRun: boolean;
	quiet: boolean;
	interval: number;
}

/** 单页处理计划 */
interface RemovalPlan {
	/** 移除后的正文 */
	text: string;
	/** 被移除的模板名（去重、按出现顺序） */
	removed: string[];
	/** 被移除调用的正文片段（供审核） */
	snippets: string[];
}

const api = createZhApi();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** MediaWiki 标题归一化：下划线转空格、去首尾空白、首字母大写 */
function normalizeTitle(title: string): string {
	const cleaned = title.trim().replace(/_/g, ' ');
	return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : cleaned;
}

/** 模板名归一化：命名空间前缀小写、主体按 normalizeTitle 处理 */
function normalizeTemplateName(name: string): string {
	const colon = name.indexOf(':');
	if (colon === -1) return normalizeTitle(name);
	return `${name.slice(0, colon).replace(/_/g, ' ').trim().toLowerCase()}:${normalizeTitle(name.slice(colon + 1))}`;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = { dryRun: false, quiet: false, interval: DEFAULT_INTERVAL };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--quiet') {
			result.quiet = true;
		} else if (arg === '--interval' && args[i + 1]) {
			const parsed = Number.parseInt(args[i + 1], 10);
			if (Number.isFinite(parsed) && parsed >= 0) {
				result.interval = parsed;
			}
			i++;
		}
	}
	return result;
}

/** 从页面标题解析归属用户；非用户命名空间返回 null（用户名不含斜杠，首个斜杠即子页分界） */
function ownerOf(title: string): string | null {
	if (!title.startsWith('User:')) return null;
	const rest = title.slice('User:'.length);
	const slash = rest.indexOf('/');
	const name = (slash === -1 ? rest : rest.slice(0, slash)).trim();
	return name === '' ? null : name;
}

/** 建立「归一化模板名 → 规则」映射，含重定向别名 */
async function buildTemplateMap(): Promise<Map<string, UserboxRule>> {
	const withFullName = RULES.map((rule) => ({ ...rule, templateName: `Template:${rule.template}` }));
	const rawMap = await buildTemplateNameMap(api, withFullName);
	const map = new Map<string, UserboxRule>();
	for (const [key, value] of rawMap) {
		map.set(normalizeTemplateName(key), value);
	}
	return map;
}

/** 发现阶段：各目标模板在用户命名空间的全部嵌入页（含子页） */
async function discoverPages(log: (msg: string) => void): Promise<string[]> {
	const found = new Set<string>();
	for (const rule of RULES) {
		let eicontinue: string | undefined;
		do {
			const params: Record<string, string | number> = {
				action: 'query',
				list: 'embeddedin',
				eititle: `Template:${rule.template}`,
				einamespace: USER_NAMESPACE,
				eilimit: 'max',
			};
			if (eicontinue) params.eicontinue = eicontinue;

			const { data } = await api.post<ApiQueryResponse>(params, { retry: 15 } as any);
			for (const ei of data.query?.embeddedin ?? []) {
				found.add(ei.title);
			}
			eicontinue = data.continue?.eicontinue;
			if (eicontinue) await sleep(1000);
		} while (eicontinue);
		log(`${PREFIX}   ${rule.template}: 累计候选 ${found.size} 页`);
	}
	return [...found].sort();
}

/** 批量查询用户的组成员（含隐式组；用户不存在则为空集） */
async function fetchGroups(names: string[]): Promise<Map<string, Set<string>>> {
	const result = new Map<string, Set<string>>();
	for (let i = 0; i < names.length; i += USER_QUERY_BATCH) {
		const batch = names.slice(i, i + USER_QUERY_BATCH);
		const { data } = await api.post<ApiQueryResponse>({
			action: 'query',
			format: 'json',
			formatversion: '2',
			list: 'users',
			ususers: batch.join('|'),
			usprop: 'groups',
		}, { retry: 15 } as any);
		for (const user of data.query?.users ?? []) {
			if (typeof user.name === 'string') {
				result.set(user.name, new Set(user.groups ?? []));
			}
		}
		if (i + USER_QUERY_BATCH < names.length) await sleep(1000);
	}
	return result;
}

/** 拉取页面最新正文与修订 ID；编辑前必须以最新内容为准 */
async function fetchPageData(title: string): Promise<{ content: string | null; revid: number | null }> {
	const { data } = await api.post<ApiQueryResponse>({
		action: 'query',
		format: 'json',
		formatversion: '2',
		prop: 'revisions',
		rvprop: ['content', 'ids'],
		rvslots: 'main',
		titles: title,
	}, { retry: 15 } as any);
	const page = data.query?.pages?.[0];
	if (page?.missing) return { content: null, revid: null };
	const revision = page?.revisions?.[0];
	const content = revision?.slots?.main?.content;
	if (typeof content !== 'string') return { content: null, revid: null };
	return { content, revid: typeof revision?.revid === 'number' ? revision.revid : null };
}

/** 本轮内的页面内容缓存，避免判定与嵌入追踪重复拉取 */
const pageCache = new Map<string, { content: string | null; revid: number | null }>();

async function getPageData(title: string): Promise<{ content: string | null; revid: number | null }> {
	const cached = pageCache.get(title);
	if (cached) return cached;
	const data = await fetchPageData(title);
	pageCache.set(title, data);
	return data;
}

/** User 命名空间的前缀写法（含中文别名） */
const USER_NAMESPACES = new Set(['user', '用户']);

/** 是否为相对子页嵌入写法 {{/子页}}（解析器会把名字归一化为 Template:/子页） */
function isRelativeSubpage(token: Parser.TranscludeToken): boolean {
	return token.toString().replace(/^\{\{\s*/, '').startsWith('/');
}

/**
 * 收集页面会传递给上级的 User 命名空间嵌入目标（相对子页写法按当前标题展开）。
 * 判断的是「被嵌入时会把什么传出去」，故按嵌入语义解析（include=true）。
 */
function collectTranscludedUserPages(content: string, selfTitle: string, transcluded: boolean): string[] {
	const parsed = Parser.parse(content, transcluded);
	const titles: string[] = [];
	for (const token of parsed.querySelectorAll<Parser.TranscludeToken>('template')) {
		let name = token.name.trim();
		if (isRelativeSubpage(token)) {
			// 形如 Template:/子页，取斜杠起的部分拼到当前标题
			const slash = name.indexOf('/');
			name = slash === -1 ? name : `${selfTitle}${name.slice(slash)}`;
		} else if (name.startsWith('/')) {
			name = `${selfTitle}${name}`;
		}
		const colon = name.indexOf(':');
		if (colon === -1) continue;
		const namespace = name.slice(0, colon).replace(/_/g, ' ').trim().toLowerCase();
		if (!USER_NAMESPACES.has(namespace)) continue;
		const title = `User:${name.slice(colon + 1).replace(/_/g, ' ').trim()}`;
		if (title !== 'User:' && !titles.includes(title)) titles.push(title);
	}
	return titles;
}

/** 判断页面是否会展示在用户根页面上：根页面本身，或被根页面递归嵌入的页面 */
async function isDisplayedOnRoot(rootTitle: string, target: string): Promise<boolean> {
	if (target === rootTitle) return true;
	const visited = new Set<string>([rootTitle]);
	let frontier: string[] = [rootTitle];
	for (let depth = 0; depth < MAX_TRANSCLUSION_DEPTH && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const title of frontier) {
			const { content } = await getPageData(title);
			if (content === null) continue;
			// 根页面按自身显示的语义解析，更深层按被嵌入的语义解析
			const transcluded = title !== rootTitle;
			for (const child of collectTranscludedUserPages(content, title, transcluded)) {
				if (child === target) return true;
				if (!visited.has(child)) {
					visited.add(child);
					next.push(child);
				}
			}
		}
		frontier = next;
	}
	return false;
}

/** 收集「用户已无对应权限却仍挂载」的目标模板调用 */
function collectUnauthorized(
	parsed: Parser.Token,
	groups: Set<string>,
	templateMap: Map<string, UserboxRule>,
): Parser.TranscludeToken[] {
	const targets: Parser.TranscludeToken[] = [];
	for (const token of parsed.querySelectorAll<Parser.TranscludeToken>('template')) {
		const rule = templateMap.get(normalizeTemplateName(token.name));
		if (rule && !rule.groups.some((group) => groups.has(group))) {
			targets.push(token);
		}
	}
	return targets;
}

/**
 * 删除模板调用；独占一行（行首允许空白缩进）时连整行一起删除。
 * 原生 remove(true) 只处理行首无缩进的情形，故先删掉行首空白使该判定成立。
 */
function removeTokenWithLine(token: Parser.TranscludeToken): void {
	const prev = token.previousSibling;
	if (prev?.type === 'text') {
		const text = prev as AstText;
		const data = text.data;
		const lastNewline = data.lastIndexOf('\n');
		const indent = data.slice(lastNewline + 1);
		if (indent !== '' && indent.trim() === '') {
			text.deleteData(lastNewline + 1, indent.length);
		}
	}
	token.remove(true);
}

/** 生成单页移除计划；无需移除时返回 null。transcluded 表示该页是以被嵌入的形式展示 */
function planRemoval(
	content: string,
	groups: Set<string>,
	templateMap: Map<string, UserboxRule>,
	transcluded: boolean,
): RemovalPlan | null {
	const parsed = Parser.parse(content, transcluded);
	const targets = collectUnauthorized(parsed, groups, templateMap);
	if (targets.length === 0) return null;

	const removed: string[] = [];
	const snippets: string[] = [];
	for (const token of targets) {
		const rule = templateMap.get(normalizeTemplateName(token.name));
		if (rule && !removed.includes(rule.template)) {
			removed.push(rule.template);
		}
		const snippet = token.toString().trim().replace(/\s+/g, ' ');
		snippets.push(snippet.length > 80 ? `${snippet.slice(0, 80)}…` : snippet);
		removeTokenWithLine(token);
	}
	return { text: parsed.toString(), removed, snippets };
}

/**
 * AbuseFilter 分类：萌百的 warn 类过滤器在同一会话内记录「已警告」标记，
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

async function attemptEdit(params: MwApiParams): Promise<{ data: ApiEditResponse | null; thrown: Error | null }> {
	try {
		const { data } = await api.postWithEditToken<ApiEditResponse>(params);
		return { data, thrown: null };
	} catch (error) {
		return { data: null, thrown: error as Error };
	}
}

/** 提交单页编辑；baserevid 提供编辑冲突检测，nocreate 防止竞态下意外创建页面 */
async function submitEdit(title: string, text: string, baserevid: number, summary: string, log: (msg: string) => void): Promise<void> {
	const params = {
		action: 'edit',
		format: 'json',
		formatversion: '2',
		title,
		text,
		summary,
		baserevid,
		nocreate: 1,
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
	if (thrown) {
		// moderation-*-queued 也可能以抛出的错误形态出现，同样视为成功
		if (checkModerationQueuedError(thrown, '  编辑请求已进入审核队列（视为成功）')) return;
		throw thrown;
	}
	// moderation-*-queued 是 error 形态的成功响应，必须在 extractApiError 判失败之前处理
	if (checkModerationQueued(data, '  编辑请求已进入审核队列（视为成功）')) return;
	const apiError = extractApiError(data);
	if (apiError) throw new Error(`[${apiError.code}] ${apiError.info}`);
	if (data?.edit?.result !== 'Success') {
		throw new Error(`编辑响应异常: ${JSON.stringify(data)}`);
	}
}

interface PageOutcome {
	status: 'skip' | 'edited' | 'dry-run';
	/** 跳过原因：no-change 复核后无需移除，not-displayed 未展示在用户根页面 */
	skipReason?: 'no-change' | 'not-displayed';
	removed: string[];
	snippets: string[];
}

/** 处理单页：重拉最新正文 → 移除无权限用户框 → 复检 → 提交 */
async function processPage(
	title: string,
	owner: string,
	groups: Set<string>,
	templateMap: Map<string, UserboxRule>,
	dryRun: boolean,
	log: (msg: string) => void,
): Promise<PageOutcome> {
	const rootTitle = `User:${owner}`;
	const transcluded = title !== rootTitle;
	const { content, revid } = await getPageData(title);
	if (content === null) {
		log(`${PREFIX}   ${title}: 页面不存在或无法读取，跳过`);
		return { status: 'skip', removed: [], snippets: [] };
	}
	if (revid === null) {
		log(`${PREFIX}   ${title}: 未取得修订 ID，跳过`);
		return { status: 'skip', removed: [], snippets: [] };
	}

	const plan = planRemoval(content, groups, templateMap, transcluded);
	if (!plan) {
		log(`${PREFIX}   ${title}: 复核后无需移除`);
		return { status: 'skip', skipReason: 'no-change', removed: [], snippets: [] };
	}

	// 边界：只处理会在用户根页面上展示的用户框（根页面本身，或被根页面嵌入的子页）
	if (!(await isDisplayedOnRoot(rootTitle, title))) {
		log(`${PREFIX}   ${title}: 未展示在根页面 ${rootTitle}，跳过`);
		return { status: 'skip', skipReason: 'not-displayed', removed: [], snippets: [] };
	}

	// 复检：移除后不应再残留无权限的目标模板
	const leftover = collectUnauthorized(Parser.parse(plan.text, transcluded), groups, templateMap);
	if (leftover.length > 0) {
		throw new Error(`移除后仍残留 ${leftover.length} 处目标模板，放弃编辑`);
	}

	if (dryRun) {
		log(`${PREFIX}   [DRY-RUN] ${title}: 将移除 ${plan.removed.join('、')}`);
		for (const snippet of plan.snippets) {
			log(`${PREFIX}       - ${snippet}`);
		}
		return { status: 'dry-run', removed: plan.removed, snippets: plan.snippets };
	}

	const summary = `机器人：移除无对应权限的用户框（${plan.removed.join('、')}）`;
	await submitEdit(title, plan.text, revid, summary, log);
	log(`${PREFIX}   ${title}: 已移除 ${plan.removed.join('、')}`);
	return { status: 'edited', removed: plan.removed, snippets: plan.snippets };
}

(async () => {
	const args = process.argv.slice(2);
	if (args.includes('--help')) {
		console.log(USAGE);
		return;
	}
	const { dryRun, quiet, interval } = parseArgs(args);
	const log = (msg: string): void => {
		if (!quiet) console.log(msg);
	};

	try {
		await clientlogin(api, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!);

		log(`${PREFIX} 建立模板名映射（含重定向别名）...`);
		const templateMap = await buildTemplateMap();
		log(`${PREFIX} 模板别名数: ${templateMap.size}`);

		log(`${PREFIX} 发现嵌入目标模板的用户页...`);
		const pages = await discoverPages(log);
		log(`${PREFIX} 候选页面: ${pages.length}`);

		const ownership = new Map<string, string>();
		for (const title of pages) {
			const owner = ownerOf(title);
			if (owner) ownership.set(title, owner);
		}
		const owners = [...new Set(ownership.values())];
		log(`${PREFIX} 归属用户: ${owners.length}`);

		const groupsByUser = await fetchGroups(owners);
		const missingUsers = owners.filter((name) => !groupsByUser.has(name));
		if (missingUsers.length > 0) {
			log(`${PREFIX} 用户不存在（视为无权限）: ${missingUsers.join('、')}`);
		}

		const failures: string[] = [];
		const stats = { scanned: 0, skipped: 0, notDisplayed: 0, edited: 0, dryRun: 0 };
		const removedTemplates = new Map<string, number>();

		for (const [title, owner] of ownership) {
			stats.scanned++;
			const groups = groupsByUser.get(owner) ?? new Set<string>();
			let submitted = false;
			try {
				const outcome = await processPage(title, owner, groups, templateMap, dryRun, log);
				if (outcome.status === 'skip') {
					stats.skipped++;
					if (outcome.skipReason === 'not-displayed') stats.notDisplayed++;
				} else if (outcome.status === 'dry-run') {
					stats.dryRun++;
				} else {
					stats.edited++;
					submitted = true;
				}
				for (const name of outcome.removed) {
					removedTemplates.set(name, (removedTemplates.get(name) ?? 0) + 1);
				}
			} catch (error: unknown) {
				const err = error instanceof Error ? error : new Error(String(error));
				if (isPermissionDeniedError(err)) {
					console.error(`${PREFIX} 权限不足，终止: ${err.message}`);
					process.exit(1);
				}
				failures.push(`${title}: ${err.message}`);
				console.error(`${PREFIX}   ${title}: 失败 - ${err.message}`);
			}
			if (submitted && interval > 0) await sleep(interval);
		}

		log(`${PREFIX} === 汇总 ===`);
		log(`${PREFIX} 候选 ${stats.scanned} 页：无需移除 ${stats.skipped - stats.notDisplayed}，未展示在根页面 ${stats.notDisplayed}，${dryRun ? `待移除 ${stats.dryRun}（DRY-RUN 未编辑）` : `已编辑 ${stats.edited}`}`);
		if (removedTemplates.size > 0) {
			for (const [name, count] of [...removedTemplates].sort((a, b) => b[1] - a[1])) {
				log(`${PREFIX}   ${name} × ${count}`);
			}
		}
		if (failures.length > 0) {
			console.error(`${PREFIX} 失败 ${failures.length} 页:`);
			for (const failure of failures) console.error(`${PREFIX}   ${failure}`);
			process.exitCode = 1;
		}
	} catch (error: unknown) {
		const err = error instanceof Error ? error : new Error(String(error));
		console.error(`${PREFIX} 发生错误: ${err.name}: ${err.message}`);
		process.exit(1);
	}
})();
