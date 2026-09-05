import { MediaWikiApi } from 'wiki-saikou';
import { createZhApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { withApiRetry, extractApiError, isModerationQueuedCode, isPermissionDeniedError } from '../utils/retry.js';
import type { ApiError } from '../utils/retry.js';

const PREFIX = '[RevertBadMove]';

// 本次事故：Replace Text 的正则把 `植物大战僵尸2:X` 误移动成了 `(植物大战僵尸2)X`
const DEFAULT_BAD_PREFIX = '(植物大战僵尸2)';
const DEFAULT_GOOD_PREFIX = '植物大战僵尸2:';
const DEFAULT_REASON = '回退错误移动';

// 业务性错误，重试没有意义，直接跳过并记入报告
const NON_RETRYABLE_CODES = new Set([
	'articleexists',
	'badtitle',
	'cantmove',
	'cascadeprotected',
	'filetypemismatch',
	'immobilenamespace',
	'invalidtitle',
	'missingtitle',
	'move-over-sharedfile',
	'protectedpage',
	'protectedtitle',
	'selfmove',
]);

interface CliArgs {
	badPrefix: string;
	goodPrefix: string;
	namespace: string;
	reason: string;
	limit: number;
	interval: number;
	dryRun: boolean;
	verbose: boolean;
}

interface MovePlan {
	from: string;
	to: string;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		badPrefix: DEFAULT_BAD_PREFIX,
		goodPrefix: DEFAULT_GOOD_PREFIX,
		namespace: '0',
		reason: DEFAULT_REASON,
		limit: 0,
		interval: 1500,
		dryRun: false,
		verbose: true,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--quiet') {
			result.verbose = false;
		} else if (arg === '--bad-prefix' && next) {
			result.badPrefix = next;
			i++;
		} else if (arg === '--good-prefix' && next) {
			result.goodPrefix = next;
			i++;
		} else if (arg === '--namespace' && next) {
			result.namespace = next;
			i++;
		} else if (arg === '--reason' && next) {
			result.reason = next;
			i++;
		} else if (arg === '--limit' && next) {
			result.limit = parseInt(next, 10);
			i++;
		} else if (arg === '--interval' && next) {
			result.interval = parseInt(next, 10);
			i++;
		}
	}

	return result;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function findKnownCode(text: string): string | null {
	const lower = text.toLowerCase();
	for (const code of NON_RETRYABLE_CODES) {
		if (lower.includes(code)) return code;
	}
	return null;
}

/** 错误分类：决定重试与否、以及计入结果时的归类 */
type MoveErrorCategory = 'moderation-queued' | 'tags-rejected' | 'business' | 'transient';

function classifyMoveError(code: string, info?: string): MoveErrorCategory {
	const text = info === undefined ? code : `${code}\n${info}`;
	if (isModerationQueuedCode(text)) return 'moderation-queued';
	if (text.includes('tags-apply-not-allowed')) return 'tags-rejected';
	if (findKnownCode(text) !== null) return 'business';
	return 'transient';
}

/** 枚举主命名空间下所有以坏前缀开头的现存页面 */
async function collectBadPages(
	api: MediaWikiApi,
	badPrefix: string,
	namespace: string,
	verbose: boolean,
): Promise<string[]> {
	const titles: string[] = [];
	let apcontinue: string | undefined;

	do {
		const { data } = await api.post<any>(
			{
				action: 'query',
				format: 'json',
				formatversion: '2',
				list: 'allpages',
				apnamespace: namespace,
				apprefix: badPrefix,
				apfilterredir: 'all',
				aplimit: 'max',
				...(apcontinue === undefined ? {} : { apcontinue }),
			},
			{ retry: 15, noCache: true } as any,
		);

		const err = extractApiError(data);
		if (err) {
			throw new Error(`枚举页面失败: ${err.code} — ${err.info}`);
		}

		for (const page of data?.query?.allpages ?? []) {
			titles.push(page.title as string);
		}

		apcontinue = data?.continue?.apcontinue;
		if (verbose) {
			console.log(`${PREFIX} 已收集 ${titles.length} 个页面${apcontinue ? '，继续分页…' : ''}`);
		}
		if (apcontinue !== undefined) {
			await sleep(1000);
		}
	} while (apcontinue !== undefined);

	return titles;
}

/** dry-run 预览：批量查询目标标题现状，提示哪些预计会被服务端拒绝 */
async function previewTargets(api: MediaWikiApi, plans: MovePlan[]): Promise<void> {
	const BATCH = 50;
	for (let i = 0; i < plans.length; i += BATCH) {
		const batch = plans.slice(i, i + BATCH);
		const { data } = await api.post<any>(
			{
				action: 'query',
				format: 'json',
				formatversion: '2',
				prop: 'info',
				titles: batch.map((p) => p.to).join('|'),
			},
			{ retry: 15, noCache: true } as any,
		);

		const byTitle = new Map<string, any>();
		for (const page of data?.query?.pages ?? []) {
			byTitle.set(page.title as string, page);
		}

		for (const plan of batch) {
			const page = byTitle.get(plan.to);
			let state: string;
			if (page === undefined) {
				state = '目标状态未知';
			} else if (page.missing === true) {
				state = '目标不存在，可直接移动';
			} else if (page.redirect === true) {
				state = '目标是重定向，单版本时可覆盖移动';
			} else {
				state = '目标是实体页面，预计被服务端拒绝 (articleexists)';
			}
			console.log(`[DRY-RUN] ${plan.from} → ${plan.to} （${state}）`);
		}

		if (i + BATCH < plans.length) {
			await sleep(500);
		}
	}
}

// `Bot` 标签在移动日志上未必可用；一旦被拒绝就对后续全部页面停用
let useTags = true;

async function moveOnce(
	api: MediaWikiApi,
	plan: MovePlan,
	reason: string,
	verbose: boolean,
): Promise<ApiError | null> {
	const data = await withApiRetry<any>(
		() =>
			api.postWithToken('csrf', {
				action: 'move',
				format: 'json',
				formatversion: '2',
				from: plan.from,
				to: plan.to,
				reason,
				noredirect: true,
				movetalk: true,
				movesubpages: true,
				...(useTags ? { tags: 'Bot' } : {}),
			}),
		{
			maxRetries: 3,
			baseDelay: 2000,
			shouldRetry: (err) => !isPermissionDeniedError(err) && classifyMoveError(err.message ?? '') === 'transient',
			onRetry: (attempt, delay) => {
				if (verbose) console.log(`  ${plan.from} 重试第${attempt}次，等待${delay}ms`);
			},
		},
	).catch((err: unknown) => {
		if (isPermissionDeniedError(err as Error)) {
			console.error(`${PREFIX} 权限不足，终止`);
			process.exit(1);
		}
		const msg = err instanceof Error ? err.message : String(err);
		return { error: { code: findKnownCode(msg) ?? 'exception', info: msg } };
	});

	return extractApiError(data);
}

/** 移动单个页面；`Bot` 标签被拒时自动去掉标签重试一次 */
async function movePage(
	api: MediaWikiApi,
	plan: MovePlan,
	reason: string,
	verbose: boolean,
): Promise<ApiError | null> {
	const err = await moveOnce(api, plan, reason, verbose);
	if (err !== null && useTags && classifyMoveError(err.code, err.info) === 'tags-rejected') {
		useTags = false;
		console.log(`${PREFIX} 移动日志不接受 Bot 标签，后续不再附加标签，重试当前页面`);
		return moveOnce(api, plan, reason, verbose);
	}
	return err;
}

const api = createZhApi();

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const { badPrefix, goodPrefix, namespace, reason, limit, interval, dryRun, verbose } =
		parseArgs(process.argv.slice(2));

	console.log(`${PREFIX} 坏前缀: ${badPrefix}`);
	console.log(`${PREFIX} 正确前缀: ${goodPrefix}`);
	console.log(`${PREFIX} 命名空间: ${namespace}`);
	console.log(`${PREFIX} 摘要: ${reason}`);
	console.log(`${PREFIX} 上限: ${limit > 0 ? limit : '无'}，间隔: ${interval}ms`);
	console.log(`${PREFIX} 模式: ${dryRun ? 'DRY-RUN' : '正式执行'}`);

	await clientlogin(api, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!);

	console.log(`\n=== 枚举待回退页面 ===`);
	const titles = await collectBadPages(api, badPrefix, namespace, verbose);

	// apprefix 枚举结果必然带坏前缀，直接映射
	const plans: MovePlan[] = titles.map((from) => ({
		from,
		to: goodPrefix + from.slice(badPrefix.length),
	}));

	const targets = limit > 0 ? plans.slice(0, limit) : plans;
	console.log(`${PREFIX} 命中 ${plans.length} 个页面，本次处理 ${targets.length} 个`);

	if (targets.length === 0) {
		console.log(`${PREFIX} 没有需要回退的页面，退出。`);
		console.log(`End time: ${new Date().toISOString()}`);
		return;
	}

	if (dryRun) {
		console.log(`\n=== DRY-RUN 预览 ===`);
		await previewTargets(api, targets);
		console.log(`\n${PREFIX} DRY-RUN 结束，计划移动 ${targets.length} 个页面。`);
		console.log(`End time: ${new Date().toISOString()}`);
		return;
	}

	console.log(`\n=== 执行回退移动 ===`);
	let success = 0;
	let queued = 0;
	const skipped: string[] = [];

	for (let i = 0; i < targets.length; i++) {
		const plan = targets[i];
		const err = await movePage(api, plan, reason, verbose);

		if (err === null) {
			success++;
			if (verbose) {
				console.log(`  [${i + 1}/${targets.length}] ${plan.from} → ${plan.to}`);
			}
		} else if (classifyMoveError(err.code, err.info) === 'moderation-queued') {
			// 项目约定：审核队列 = 成功
			queued++;
			console.log(`  [${i + 1}/${targets.length}] ${plan.from} → ${plan.to} （已入审核队列）`);
		} else {
			skipped.push(`${plan.from} → ${plan.to} (${err.code}: ${err.info})`);
			console.error(`  [${i + 1}/${targets.length}] 跳过 ${plan.from}: ${err.code} — ${err.info}`);
		}

		if (i + 1 < targets.length) {
			await sleep(interval);
		}
	}

	console.log(`\n=== 汇总 ===`);
	console.log(`命中: ${plans.length}`);
	console.log(`本次处理: ${targets.length}`);
	console.log(`成功: ${success}`);
	console.log(`入队待审: ${queued}`);
	console.log(`跳过: ${skipped.length}`);
	if (skipped.length > 0) {
		console.log(`\n跳过明细（需人工判断）:`);
		for (const line of skipped) {
			console.log(`  ${line}`);
		}
	}
	console.log(`End time: ${new Date().toISOString()}`);
})();
