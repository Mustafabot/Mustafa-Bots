import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { MediaWikiApi, MwApiParams } from 'wiki-saikou';
import type { ApiEditResponse, ApiQueryResponse } from 'types-mediawiki-response';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { createCmApi, createZhApi } from '../utils/createApi.js';
import { SiteMirror, syncMirror, DEFAULT_MIRROR_NAMESPACES, type MirrorSyncResult } from '../utils/siteMirror.js';
import { checkModerationQueued, checkModerationQueuedError, extractApiError, isPermissionDeniedError } from '../utils/retry.js';
import { createEmitter, type EmitProgress } from '../core/progress.js';
import { collectMatchLines, writeScanResult, type ScanPageHit } from './scanResult.js';
import { fetchCategoryMembers } from './categoryMembers.js';
import { parseTargetList } from './targetList.js';
import { computeFingerprint, describeRule, prepareRule, trunc, validateRule, type PreparedRule, type ReplaceRule } from './replaceRules.js';

/** JSON 配置页结构 */
interface TaskConfig {
	/** 默认编辑摘要（可被 --summary 覆盖） */
	summary?: string;
	/** 替换筛选的命名空间（须为镜像已覆盖范围） */
	namespaces?: number[];
	/** 替换规则列表 */
	rules: ReplaceRule[];
}

type WikiName = 'zh' | 'cm';

interface CliArgs {
	wiki: WikiName;
	/** 位置参数：查找文本（非 --config 模式必填） */
	from?: string;
	/** 位置参数：替换文本（非 --config 模式必填） */
	to?: string;
	configPage?: string;
	/** 本地 JSON 配置文件路径（与 --config 页面标题语义一致、二者互斥） */
	configFile?: string;
	/** 以 JSON 行向 stdout 输出进度事件（供 GUI 子进程消费，本模块暂不读取） */
	progressJson?: boolean;
	summary?: string;
	namespaces?: number[];
	regex?: boolean;
	ignoreCase?: boolean;
	/** 只扫描不编辑，命中结果写入 data/gui/scans/ */
	scanOnly: boolean;
	/** 抓进镜像覆盖范围并同步的命名空间（界面上"未同步"命名空间的抓取入口） */
	addNamespaces: number[];
	/** 跳过镜像同步，直接用现有镜像搜索 */
	noSync: boolean;
	/** 提交模式：从文件读选中页面清单，逐页重取最新内容后替换编辑 */
	submit?: string;
	/** 清单模式：从文件读页面/分类清单（一行一个，分类行带前缀），展开后逐页重取最新内容替换 */
	targets?: string;
	syncOnly: boolean;
	reset: boolean;
	resync: boolean;
	purgeDeleted: boolean;
	dryRun: boolean;
	quiet: boolean;
	interval: number;
}

/** 一次替换任务的完整参数 */
interface ReplaceTask {
	summary: string;
	namespaces: number[];
	rules: PreparedRule[];
	/** checkpoint 文件命名用：配置页标题或 from→to */
	checkpointLabel: string;
	fingerprint: string;
}

interface Checkpoint {
	wiki: WikiName;
	fingerprint: string;
	completed: string[];
	failed: Record<string, string>;
}

interface LoadedCheckpoint extends Checkpoint {
	completedSet: Set<string>;
}

const DEFAULT_INTERVAL = 1500;
/** 镜像同步请求间隔（只读查询，可比编辑激进） */
const SYNC_REQUEST_INTERVAL = 300;
/** 搜索进度日志间隔（页数） */
const LOG_INTERVAL = 20000;
/** 搜索进度事件间隔（页数）：文本日志可以稀疏，界面进度条要跟上，取 iteratePages 的批大小 */
const PROGRESS_INTERVAL = 2000;

const SYNC_MODE_LABEL: Record<MirrorSyncResult['mode'], string> = {
	full: '首次全量',
	resume: '断点续传',
	incremental: '增量比对',
};

const USAGE = [
	'用法:',
	'  npx tsx src/replace/TextReplace.ts <from> <to> [--summary <文本>] [--regex] [--ignore-case]',
	'  npx tsx src/replace/TextReplace.ts --config <JSON配置页标题>',
	'  npx tsx src/replace/TextReplace.ts --config-file <本地JSON路径>',
	'  npx tsx src/replace/TextReplace.ts --config-file <本地JSON路径> --submit <选中页面清单>',
	'  npx tsx src/replace/TextReplace.ts --config-file <本地JSON路径> --targets <页面/分类清单>',
	'通用参数:',
	'  [--wiki zh|cm]          目标站点，默认 zh（决定 API、镜像库与默认命名空间：zh=0，cm=6）',
	'  [--namespace <ns,ns>]   替换时筛选的命名空间，须为镜像已覆盖范围',
	'  [--scan-only]           只扫描不编辑，命中结果写入 data/gui/scans/ 供预览',
	'  [--submit <文件>]       提交模式：读选中页面清单（每行一个标题），逐页重取最新内容后替换编辑',
	'  [--targets <文件>]      页面/分类清单模式（每行一个；分类行写 分类:/Category:/Cat:，展开其直属页面成员）',
	'  [--add-namespaces <ns,ns>] 把命名空间加进镜像覆盖范围并抓取（"未同步"命名空间的入口）',
	'  [--no-sync]             跳过镜像同步，直接用现有镜像搜索',
	'  [--sync-only]           仅同步本地镜像，不执行替换',
	'  [--reset]               丢弃编辑阶段 checkpoint 重跑（镜像保留）',
	'  [--resync]              清空本地镜像，重新全量同步',
	'  [--purge-deleted]       真正删除线上已不存在的页面（并清空历史标记），默认仅标记保留正文',
	'  [--dry-run] [--quiet] [--interval <ms>]',
	'JSON 配置页格式:',
	'  { "summary": "可选", "namespaces": [0], "rules": [{ "from": "...", "to": "...", "regex": false, "ignoreCase": false }] }',
	'说明:',
	'  - 首次运行先全量同步镜像（耗时较长、可断点续传），之后每次运行增量同步后本地搜索，只编辑命中页',
	'  - 替换在原始 wikitext 上进行，语义与 ReplaceText 一致（不感知语法、不做繁简转换）',
	'  - --submit 与 --targets 都不读镜像；--targets 的分类只展开直属页面成员（不递归子分类、不含文件）',
	'  - regex 模式时 from 必须写成 /模式/flags 正则字面量（如 /苹果/gi），to 支持 $1 等替换引用',
].join('\n');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIRROR_DIR = resolve(__dirname, '../../data/mirror');
const CHECKPOINT_DIR = resolve(__dirname, '../../data/checkpoint');
const SCAN_DIR = resolve(__dirname, '../../data/gui/scans');

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 解析 CLI 参数（支持 --key value 与 --key=value 两种写法） */
function parseArgs(argv: string[]): CliArgs | null {
	const result: CliArgs & { namespaces: number[] } = {
		wiki: 'zh',
		namespaces: [],
		scanOnly: false,
		addNamespaces: [],
		noSync: false,
		syncOnly: false,
		reset: false,
		resync: false,
		purgeDeleted: false,
		dryRun: false,
		quiet: false,
		interval: DEFAULT_INTERVAL,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		let name = arg;
		let inlineValue: string | undefined;
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			if (eq !== -1) {
				name = arg.slice(0, eq);
				inlineValue = arg.slice(eq + 1);
			}
		}
		const readValue = (): string | undefined => {
			if (inlineValue !== undefined) return inlineValue;
			if (i + 1 < argv.length) {
				i += 1;
				return argv[i];
			}
			return undefined;
		};
		const parseNsList = (raw: string | undefined): number[] => {
			const result: number[] = [];
			for (const piece of (raw ?? '').split(',')) {
				const ns = Number.parseInt(piece.trim(), 10);
				if (Number.isInteger(ns)) result.push(ns);
			}
			return result;
		};
		switch (name) {
			case '--config':
				result.configPage = readValue() ?? '';
				break;
			case '--config-file':
				result.configFile = readValue() ?? '';
				break;
			case '--wiki':
				result.wiki = (readValue() ?? '') as WikiName;
				break;
			case '--summary':
				result.summary = readValue();
				break;
			case '--namespace':
				result.namespaces.push(...parseNsList(readValue()));
				break;
			case '--interval':
				result.interval = Number.parseInt(readValue() ?? '', 10);
				break;
			case '--regex':
				result.regex = true;
				break;
			case '--ignore-case':
				result.ignoreCase = true;
				break;
			case '--submit':
				result.submit = readValue() ?? '';
				break;
			case '--targets':
				result.targets = readValue() ?? '';
				break;
			case '--scan-only':
				result.scanOnly = true;
				break;
			case '--add-namespaces':
				result.addNamespaces.push(...parseNsList(readValue()));
				break;
			case '--no-sync':
				result.noSync = true;
				break;
			case '--sync-only':
				result.syncOnly = true;
				break;
			case '--reset':
				result.reset = true;
				break;
			case '--resync':
				result.resync = true;
				break;
			case '--purge-deleted':
				result.purgeDeleted = true;
				break;
			case '--dry-run':
				result.dryRun = true;
				break;
			case '--quiet':
				result.quiet = true;
				break;
			case '--progress-json':
				result.progressJson = true;
				break;
			default:
				if (arg.startsWith('-')) {
					console.error(`未知参数: ${arg}`);
					return null;
				}
				positional.push(arg);
		}
	}
	result.from = positional[0];
	result.to = positional[1];
	if (positional.length > 2) {
		console.error('位置参数最多两个（from、to）');
		return null;
	}
	if (result.wiki !== 'zh' && result.wiki !== 'cm') {
		console.error('--wiki 只能是 zh 或 cm');
		return null;
	}
	if (!Number.isFinite(result.interval) || result.interval < 0) {
		console.error('--interval 必须是非负整数');
		return null;
	}
	if (result.configFile !== undefined && result.configPage !== undefined) {
		console.error('--config 与 --config-file 不能同时使用');
		return null;
	}
	if (result.scanOnly && result.syncOnly) {
		console.error('--scan-only 与 --sync-only 不能同时使用');
		return null;
	}
	if (result.noSync && result.syncOnly) {
		console.error('--no-sync 与 --sync-only 不能同时使用');
		return null;
	}
	if (result.noSync && result.resync) {
		console.error('--no-sync 与 --resync 不能同时使用（清空镜像后没有内容可搜）');
		return null;
	}
	if (result.noSync && result.addNamespaces.length > 0) {
		console.error('--no-sync 与 --add-namespaces 不能同时使用（抓取命名空间本身就要同步）');
		return null;
	}
	if (result.scanOnly && result.submit !== undefined) {
		console.error('--scan-only 与 --submit 不能同时使用');
		return null;
	}
	if (result.submit !== undefined && result.submit === '') {
		console.error('--submit 需要选中页面清单文件路径');
		return null;
	}
	if (result.submit !== undefined && result.syncOnly) {
		console.error('--submit 不同步镜像，不能与 --sync-only 同时使用');
		return null;
	}
	if (result.submit !== undefined && result.resync) {
		console.error('--submit 与 --resync 不能同时使用（提交模式不碰镜像，清空镜像也无从重建）');
		return null;
	}
	if (result.targets !== undefined && result.targets === '') {
		console.error('--targets 需要页面/分类清单文件路径');
		return null;
	}
	if (result.targets !== undefined && result.submit !== undefined) {
		console.error('--targets 与 --submit 不能同时使用');
		return null;
	}
	if (result.targets !== undefined && result.scanOnly) {
		console.error('--targets 与 --scan-only 不能同时使用');
		return null;
	}
	if (result.targets !== undefined && result.syncOnly) {
		console.error('--targets 不同步镜像，不能与 --sync-only 同时使用');
		return null;
	}
	if (result.targets !== undefined && result.resync) {
		console.error('--targets 与 --resync 不能同时使用（清单模式不碰镜像，清空镜像也无从重建）');
		return null;
	}
	if (result.configFile !== undefined && result.configFile === '') {
		console.error('--config-file 需要本地文件路径');
		return null;
	}
	if (result.configPage !== undefined || result.configFile !== undefined) {
		if (result.configPage === '') {
			console.error('--config 需要配置页标题');
			return null;
		}
		if (result.from !== undefined || result.to !== undefined) {
			console.error('使用 --config 时不能同时传位置参数 from/to');
			return null;
		}
	} else if (!result.syncOnly && (result.from === undefined || result.to === undefined)) {
		console.error(USAGE);
		return null;
	}
	return result;
}

/** 拉取页面最新正文与修订 ID。镜像可能过期，编辑前必须以最新内容为准 */
async function fetchPageData(api: MediaWikiApi, title: string): Promise<{ content: string | null; revid: number | null }> {
	const { data } = await api.post<ApiQueryResponse>({
		action: 'query',
		format: 'json',
		formatversion: '2',
		prop: 'revisions',
		rvprop: ['content', 'ids'],
		rvslots: 'main',
		titles: title,
	});
	const pages = data?.query?.pages;
	const page = pages?.[0];
	if (page?.missing) return { content: null, revid: null };
	const revision = page?.revisions?.[0];
	const content = revision?.slots?.main?.content;
	if (typeof content !== 'string') return { content: null, revid: null };
	return { content, revid: typeof revision?.revid === 'number' ? revision.revid : null };
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

async function attemptEdit(api: MediaWikiApi, params: MwApiParams): Promise<{ data: ApiEditResponse | null; thrown: Error | null }> {
	try {
		const { data } = await api.postWithEditToken<ApiEditResponse>(params);
		return { data, thrown: null };
	} catch (error) {
		return { data: null, thrown: error as Error };
	}
}

/** 提交单页编辑；baserevid 提供编辑冲突检测，nocreate 防止竞态下意外创建页面 */
async function submitEdit(
	api: MediaWikiApi,
	title: string,
	text: string,
	baserevid: number,
	summary: string,
	log: (msg: string) => void,
): Promise<number | null> {
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
	let { data, thrown } = await attemptEdit(api, params);
	let classification = classifyAbuseFilter([data, thrown]);
	if (classification === 'retry') {
		log('  AbuseFilter 警告，同会话重试一次');
		({ data, thrown } = await attemptEdit(api, params));
		classification = classifyAbuseFilter([data, thrown]);
	}
	if (classification !== 'none') {
		throw new Error(`AbuseFilter ${classification === 'disallowed' ? '拒绝编辑' : '警告重试后仍未通过'}: ${data ? JSON.stringify(data) : thrown?.message}`);
	}
	if (thrown) {
		// moderation-*-queued 也可能以抛出的错误形态出现，同样视为成功
		if (checkModerationQueuedError(thrown, '  编辑请求已进入审核队列（视为成功）')) return null;
		throw thrown;
	}
	// moderation-*-queued 是 error 形态的成功响应，必须在 extractApiError 判失败之前处理
	if (checkModerationQueued(data, '  编辑请求已进入审核队列（视为成功）')) return null;
	const apiError = extractApiError(data);
	if (apiError) throw new Error(`[${apiError.code}] ${apiError.info}`);
	if (data?.edit?.result !== 'Success') {
		throw new Error(`编辑响应异常: ${JSON.stringify(data)}`);
	}
	const newrevid = (data.edit as { newrevid?: number }).newrevid;
	return typeof newrevid === 'number' ? newrevid : null;
}

/** 默认编辑摘要 */
function defaultSummary(rules: ReplaceRule[]): string {
	if (rules.length === 1) {
		return `机器人：文本替换 "${trunc(rules[0].from)}" → "${trunc(rules[0].to)}"`;
	}
	return `机器人：批量文本替换（${rules.length} 条规则）`;
}

/**
 * 读取选中页面清单：UTF-8 文本，每行一个页面标题。
 * 页面标题不含换行，因此按行读取没有歧义；空行忽略、首尾空白去掉、重复项去掉。
 */
function readSubmitList(file: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf-8');
	} catch (error) {
		throw new Error(`选中页面清单 "${file}" 读取失败: ${(error as Error).message}`, { cause: error });
	}
	const titles = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '');
	if (titles.length === 0) throw new Error('选中页面清单为空');
	return [...new Set(titles)];
}

/**
 * 读取页面/分类清单：每行一个，分类行带 `分类:` / `Category:` / `Cat:` 前缀。
 * 拆分交给 parseTargetList（纯逻辑、有单测），这里只负责读文件与空清单报错。
 */
function readTargetList(file: string): ReturnType<typeof parseTargetList> {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf-8');
	} catch (error) {
		throw new Error(`页面/分类清单 "${file}" 读取失败: ${(error as Error).message}`, { cause: error });
	}
	const parsed = parseTargetList(raw);
	if (parsed.pages.length === 0 && parsed.categories.length === 0) throw new Error('页面/分类清单为空');
	return parsed;
}

/** 组装替换任务：CLI 单条规则或 JSON 配置页多条规则，统一做校验与指纹计算 */
async function buildTask(api: MediaWikiApi, cliArgs: CliArgs, defaultNamespaces: number[], log: (msg: string) => void): Promise<ReplaceTask> {
	let rules: ReplaceRule[];
	let namespaces: number[] | undefined;
	let summary: string | undefined;
	let checkpointLabel: string;
	if (cliArgs.configFile !== undefined || cliArgs.configPage !== undefined) {
		const sourceLabel = cliArgs.configFile ?? cliArgs.configPage!;
		let rawContent: string | null;
		if (cliArgs.configFile !== undefined) {
			try {
				rawContent = readFileSync(cliArgs.configFile, 'utf-8');
			} catch (error) {
				throw new Error(`本地配置文件 "${cliArgs.configFile}" 读取失败: ${(error as Error).message}`, { cause: error });
			}
		} else {
			const { content } = await fetchPageData(api, cliArgs.configPage!);
			rawContent = content;
		}
		if (rawContent === null) throw new Error(`配置来源 "${sourceLabel}" 不存在或无法获取内容`);
		let taskConfig: TaskConfig;
		try {
			taskConfig = JSON.parse(rawContent) as TaskConfig;
		} catch (error) {
			throw new Error(`配置 JSON 解析失败: ${(error as Error).message}`, { cause: error });
		}
		if (!Array.isArray(taskConfig.rules) || taskConfig.rules.length === 0) throw new Error('配置校验失败: rules 不能为空');
		for (const [i, rule] of taskConfig.rules.entries()) {
			const message = validateRule(rule, `rules[${i}]`);
			if (message) throw new Error(`配置校验失败: ${message}`);
		}
		rules = taskConfig.rules;
		namespaces = taskConfig.namespaces;
		summary = cliArgs.summary ?? taskConfig.summary;
		checkpointLabel = `${cliArgs.wiki}:${sourceLabel}`;
		log(`规则集「${sourceLabel}」共 ${rules.length} 条`);
	} else {
		const rule: ReplaceRule = {
			from: cliArgs.from!,
			to: cliArgs.to!,
			regex: cliArgs.regex || undefined,
			ignoreCase: cliArgs.ignoreCase || undefined,
		};
		const message = validateRule(rule, '规则');
		if (message) throw new Error(`参数校验失败: ${message}`);
		rules = [rule];
		checkpointLabel = `${cliArgs.wiki}:${rule.from}→${rule.to}`;
	}

	// 命名空间是否已进镜像，由调用方在搜索前校验：提交模式不搜镜像，这条规则与它无关
	const effectiveNamespaces = cliArgs.namespaces && cliArgs.namespaces.length > 0 ? cliArgs.namespaces : namespaces ?? defaultNamespaces;

	return {
		summary: summary ?? defaultSummary(rules),
		namespaces: effectiveNamespaces,
		rules: rules.map(prepareRule),
		checkpointLabel,
		fingerprint: computeFingerprint({ wiki: cliArgs.wiki, namespaces: effectiveNamespaces, rules }),
	};
}

/** checkpoint 文件路径（含 wiki 与任务标签，跨站同名任务互不干扰） */
function checkpointFile(label: string): string {
	const safe = label.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
	const hash = createHash('md5').update(label).digest('hex').slice(0, 8);
	return resolve(CHECKPOINT_DIR, `text_replace_${safe}_${hash}.json`);
}

function loadCheckpoint(cliArgs: CliArgs, task: ReplaceTask): LoadedCheckpoint {
	if (cliArgs.dryRun) {
		return { wiki: cliArgs.wiki, fingerprint: task.fingerprint, completed: [], failed: {}, completedSet: new Set() };
	}
	const file = checkpointFile(task.checkpointLabel);
	if (cliArgs.reset && existsSync(file)) {
		rmSync(file);
		console.log('已清除 checkpoint');
	}
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Checkpoint;
			if (parsed.wiki === cliArgs.wiki && parsed.fingerprint === task.fingerprint) {
				console.log(`续跑：checkpoint 中已完成 ${parsed.completed.length} 页，将跳过`);
				return { ...parsed, completedSet: new Set(parsed.completed) };
			}
			console.log('任务指纹变化，作废旧 checkpoint，重新开始');
		} catch {
			console.log('checkpoint 损坏，重新开始');
		}
	}
	return { wiki: cliArgs.wiki, fingerprint: task.fingerprint, completed: [], failed: {}, completedSet: new Set() };
}

function saveCheckpoint(file: string, checkpoint: LoadedCheckpoint): void {
	if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true });
	const { completedSet, ...rest } = checkpoint;
	void completedSet;
	writeFileSync(file, JSON.stringify(rest, null, 2), 'utf-8');
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	const cliArgs = parseArgs(process.argv.slice(2));
	if (!cliArgs) process.exit(1);
	const verbose = !cliArgs.quiet;
	const log = (msg: string) => {
		if (verbose) console.log(msg);
	};
	const emit: EmitProgress = createEmitter(cliArgs.progressJson === true);
	emit({ type: 'start', task: 'text-replace' });
	let mirror: SiteMirror | null = null;
	// 三个计数器必须声明在 try 之外：外层 catch 也要读它们——
	// 循环中途抛错（如 checkpoint 写入失败）时，已完成的编辑数不能被伪造成 0
	let changed = 0;
	let staleSkipped = 0;
	let failed = 0;
	try {
		if (cliArgs.resync) {
			for (const suffix of ['', '-wal', '-shm']) {
				const file = resolve(MIRROR_DIR, `${cliArgs.wiki}.db${suffix}`);
				if (existsSync(file)) rmSync(file);
			}
			log('已清空本地镜像，将重新全量同步');
		}

		const api = cliArgs.wiki === 'zh' ? createZhApi() : createCmApi();
		const siteConfig = config[cliArgs.wiki];
		await clientlogin(api, siteConfig.bot.clientUsername!, siteConfig.bot.clientPassword!, siteConfig.api);

		// 提交/清单模式逐页重取最新内容，既不读镜像也不写镜像，因此整段镜像逻辑都跳过
		const usesMirror = cliArgs.submit === undefined && cliArgs.targets === undefined;
		let coveredNamespaces = DEFAULT_MIRROR_NAMESPACES[cliArgs.wiki];
		if (usesMirror) {
			mirror = new SiteMirror(resolve(MIRROR_DIR, `${cliArgs.wiki}.db`));
			coveredNamespaces = mirror.getNamespaces() ?? DEFAULT_MIRROR_NAMESPACES[cliArgs.wiki];
			if (cliArgs.addNamespaces.length > 0) {
				coveredNamespaces = [...new Set([...coveredNamespaces, ...cliArgs.addNamespaces])].sort((a, b) => a - b);
				mirror.setNamespaces(coveredNamespaces);
				log(`镜像覆盖范围更新为 ${coveredNamespaces.join('|')}`);
			}
		}

		// 任务构建在同步之前：配置页拉取或参数错误应尽快失败，不浪费时间等待同步
		const task = cliArgs.syncOnly ? null : await buildTask(api, cliArgs, DEFAULT_MIRROR_NAMESPACES[cliArgs.wiki], log);
		if (task) log(`站点 ${cliArgs.wiki}，命名空间 ${task.namespaces.join('|')}，规则 ${task.rules.length} 条`);

		if (usesMirror && mirror && task) {
			// 搜索范围必须落在镜像覆盖范围内，否则会静默地一页也搜不到
			const invalid = task.namespaces.filter((ns) => !coveredNamespaces.includes(ns));
			if (invalid.length > 0) {
				throw new Error(`命名空间 ${invalid.join(',')} 未同步进本地镜像（当前覆盖 ${coveredNamespaces.join(',')}）；请先用 --add-namespaces ${invalid.join(',')} 抓取后重试`);
			}
		}

		if (usesMirror && mirror) {
			if (cliArgs.noSync) {
				log('按 --no-sync 跳过镜像同步，直接使用现有镜像');
				emit({ type: 'phase', name: '跳过同步' });
			} else {
				emit({ type: 'phase', name: '同步镜像' });
				const syncResult = await syncMirror({
					api,
					mirror,
					namespaces: coveredNamespaces,
					requestInterval: SYNC_REQUEST_INTERVAL,
					log,
					purgeDeleted: cliArgs.purgeDeleted,
					// 同步可能跑几十分钟：把进度转成结构化事件，界面进度条才不会空转
					onProgress: (progress) =>
						emit({
							type: 'progress',
							done: progress.done,
							...(progress.total === undefined ? {} : { total: progress.total }),
							...(progress.message === undefined ? {} : { message: progress.message }),
						}),
				});
				const deletedNote = syncResult.markedDeleted > 0 ? `，${cliArgs.purgeDeleted ? '删除' : '标记删除'} ${syncResult.markedDeleted} 页` : '';
				const deletedTotal = mirror.getDeletedPageCount();
				console.log(
					`镜像同步完成（${SYNC_MODE_LABEL[syncResult.mode]}）：写入 ${syncResult.upserted} 页${deletedNote}，镜像共 ${mirror.getPageCount()} 页` +
						(deletedTotal > 0 ? `（另有 ${deletedTotal} 页已标记删除）` : ''),
				);
			}
		}

		if (cliArgs.syncOnly || !task) {
			console.log('--sync-only 完成，未执行替换');
			emit({ type: 'done', summary: { changed: 0, staleSkipped: 0, failed: 0 } });
			return;
		}

		// #region 待处理页面清单
		const candidates = new Map<string, number[]>();
		const scanHits: ScanPageHit[] = [];
		let scanned = 0;
		let titles: string[];
		if (cliArgs.submit !== undefined) {
			titles = readSubmitList(cliArgs.submit);
			console.log(`提交模式：共 ${titles.length} 页，逐页重取最新内容后替换${cliArgs.dryRun ? '（dry-run）' : ''}`);
			emit({ type: 'phase', name: '提交编辑' });
		} else if (cliArgs.targets !== undefined) {
			const targets = readTargetList(cliArgs.targets);
			emit({ type: 'phase', name: '展开分类' });
			const expanded: string[] = [];
			for (const [index, category] of targets.categories.entries()) {
				const members = await fetchCategoryMembers(api, category);
				log(`分类 ${category}：${members.length} 页`);
				if (members.length === 0) log('  （空分类，没有页面成员）');
				expanded.push(...members);
				emit({ type: 'progress', done: index + 1, total: targets.categories.length, message: '展开分类' });
			}
			// 页面在前、分类成员在后，统一去重；顺序便于对照用户输入
			titles = [...new Set([...targets.pages, ...expanded])];
			console.log(
				`清单模式：页面 ${targets.pages.length} 个，分类 ${targets.categories.length} 个展开 ${expanded.length} 页，去重后共 ${titles.length} 页，逐页重取最新内容后替换${cliArgs.dryRun ? '（dry-run）' : ''}`,
			);
			if (titles.length === 0) {
				console.log('清单里没有可处理的页面，结束');
				emit({ type: 'done', summary: { changed: 0, staleSkipped: 0, failed: 0 } });
				return;
			}
			emit({ type: 'phase', name: '提交编辑' });
		} else {
			log(`开始本地搜索（镜像 ${mirror!.getPageCount()} 页）…`);
			emit({ type: 'phase', name: '本地搜索' });
			const nsFilter = new Set(task.namespaces);
			const rulePageHits = new Array<number>(task.rules.length).fill(0);
			for await (const page of mirror!.iteratePages()) {
				scanned++;
				if (scanned % LOG_INTERVAL === 0) {
					log(`已扫描 ${scanned} 页…`);
				}
				// 事件比日志更密：进度条只认 progress 事件，按日志间隔发会让大批量扫描看上去卡住
				if (scanned % PROGRESS_INTERVAL === 0) {
					emit({ type: 'progress', done: scanned, total: mirror!.getPageCount(), message: '扫描镜像' });
				}
				if (!nsFilter.has(page.ns)) continue;
				let hits: number[] | null = null;
				for (const [i, prepared] of task.rules.entries()) {
					if (prepared.countMatches(page.text) > 0) (hits ??= []).push(i);
				}
				if (!hits) continue;
				candidates.set(page.title, hits);
				for (const i of hits) rulePageHits[i]++;
				if (cliArgs.scanOnly) {
					// 明细必须在这一刻提取：翻页流不回头，正文只在此刻在手边
					const detail = collectMatchLines(page.text, task.rules);
					scanHits.push({ title: page.title, hits: detail.hits, matches: detail.matches });
					emit({ type: 'hit', title: page.title });
				}
			}
			log(`搜索完毕，共扫描 ${scanned} 页`);
			emit({ type: 'progress', done: scanned, total: scanned, message: `命中 ${candidates.size} 页` });
			for (const [i, prepared] of task.rules.entries()) {
				console.log(`规则 ${describeRule(prepared.rule)}：命中 ${rulePageHits[i]} 页`);
			}
			if (cliArgs.scanOnly) {
				// 没有命中也要落一份结果，界面才知道"扫过了是 0 命中"而不是"还没扫"
				const fileName = writeScanResult(SCAN_DIR, {
					version: 1,
					wiki: cliArgs.wiki,
					fingerprint: task.fingerprint,
					namespaces: task.namespaces,
					rules: task.rules.map((prepared) => prepared.rule),
					scanned,
					createdAt: Date.now(),
					hits: scanHits,
				});
				console.log(`扫描完成：命中 ${scanHits.length} 页，结果写入 data/gui/scans/${fileName}`);
				emit({ type: 'done', summary: { hits: scanHits.length, scanned }, resultFile: fileName });
				return;
			}
			if (candidates.size === 0) {
				console.log('没有命中页面，结束');
				emit({ type: 'done', summary: { changed: 0, staleSkipped: 0, failed: 0 } });
				return;
			}
			titles = [...candidates.keys()].sort();
			console.log(`命中页面共 ${titles.length} 个，开始逐页处理${cliArgs.dryRun ? '（dry-run）' : ''}`);
			emit({ type: 'phase', name: '提交编辑' });
		}
		// #endregion

		// #region 逐页重拉最新内容并替换编辑
		const submitMode = cliArgs.submit !== undefined || cliArgs.targets !== undefined;
		// 提交/清单模式不挑规则：选中的页面把规则集里的每条都试一遍；扫描结果只记命中过的规则
		const ruleIndexesFor = (title: string): number[] => (submitMode ? task.rules.map((_, i) => i) : candidates.get(title) ?? []);
		// 提交/清单模式的断点把页面清单一并算进指纹：换一批页面提交不会踩到上一批的断点，
		// 同一批页面重复提交则续跑或跳过，避免 to 仍含 from 的规则被叠加替换
		const fingerprint = submitMode
			? computeFingerprint({ wiki: cliArgs.wiki, namespaces: task.namespaces, rules: task.rules.map((prepared) => prepared.rule), titles: [...titles].sort() })
			: task.fingerprint;
		// 两种清单模式用不同标签，互不覆盖对方的断点
		const listKind = cliArgs.targets !== undefined ? 'targets' : 'submit';
		const checkpointLabel = submitMode ? `${task.checkpointLabel}:${listKind}:${fingerprint.slice(0, 12)}` : task.checkpointLabel;
		const checkpoint = loadCheckpoint(cliArgs, { ...task, fingerprint, checkpointLabel });
		const checkpointPath = checkpointFile(checkpointLabel);
		emit({ type: 'progress', done: 0, total: titles.length, message: '准备编辑' });
		for (const [index, title] of titles.entries()) {
			if (checkpoint.completedSet.has(title)) {
				log(`跳过（checkpoint 已完成）: ${title}`);
				emit({ type: 'edit', title, status: 'skipped', oldRevid: null, newRevid: null, message: '本批此前已完成，跳过' });
				// 跳过的页也要推进计数：否则中途跳过会让进度条停住，最后由 done 一次性补到底
				emit({ type: 'progress', done: index + 1, total: titles.length, message: '提交编辑' });
				continue;
			}
			try {
				const { content, revid } = await fetchPageData(api, title);
				if (content === null || revid === null) throw new Error('页面不存在或无法获取内容');
				let text = content;
				const applied: string[] = [];
				for (const i of ruleIndexesFor(title)) {
					const result = task.rules[i].apply(text);
					if (result.count > 0) {
						text = result.text;
						applied.push(`${describeRule(task.rules[i].rule)} ×${result.count}`);
					}
				}
				if (text === content) {
					// 镜像命中但最新内容已无匹配：他人已处理或镜像期间过期
					log(`  最新内容已无匹配，跳过: ${title}`);
					staleSkipped++;
					emit({ type: 'edit', title, status: 'skipped', oldRevid: revid, newRevid: null, message: '最新内容已无匹配' });
				} else if (cliArgs.dryRun) {
					log(`  [DRY-RUN] 将提交编辑: ${title}（${applied.join('，')}）`);
					changed++;
					emit({ type: 'edit', title, status: 'changed', oldRevid: revid, newRevid: null, message: '[DRY-RUN] 未提交' });
				} else {
					const newRevid = await submitEdit(api, title, text, revid, task.summary, log);
					console.log(`${title}: ${applied.join('，')}`);
					changed++;
					emit({ type: 'edit', title, status: 'changed', oldRevid: revid, newRevid, message: applied.join('，') });
				}
				// 无论结果如何均标记完成：无变化页重跑也不会有变化
				checkpoint.completed.push(title);
				checkpoint.completedSet.add(title);
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
				emit({ type: 'edit', title, status: 'failed', oldRevid: null, newRevid: null, message: err.message });
			}
			if (!cliArgs.dryRun) saveCheckpoint(checkpointPath, checkpoint);
			// 逐页发进度：界面进度条只认 progress 事件，按 50 页节流会让小批量只剩首尾两个点。
			// 每页本来就有一条 edit 事件，这里多一条不会改变事件量级
			emit({ type: 'progress', done: index + 1, total: titles.length, message: '提交编辑' });
			await sleep(cliArgs.interval);
		}

		console.log(`\n汇总：修改 ${changed} 页，最新内容已无匹配 ${staleSkipped} 页，失败 ${failed} 页` + (cliArgs.dryRun ? '（dry-run，未提交任何编辑）' : ''));
		emit({ type: 'done', summary: { changed, staleSkipped, failed } });
		if (!cliArgs.dryRun && Object.keys(checkpoint.failed).length > 0) {
			console.log('失败页面（续跑将自动重试）:');
			for (const [title, message] of Object.entries(checkpoint.failed)) {
				console.log(`  ${title}: ${message}`);
			}
		}
		// #endregion
	} catch (error) {
		const err = error as Error;
		console.error(`发生错误: ${err.name}: ${err.message}`);
		emit({ type: 'log', level: 'error', message: err.message });
		emit({ type: 'done', summary: { changed, staleSkipped, failed: failed + 1 } });
		if (err.stack) console.error(err.stack);
		process.exitCode = 1;
	} finally {
		mirror?.close();
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();
