import { MediaWikiApi } from 'wiki-saikou';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

interface CliArgs {
	title: string;
	namespace: number;
	dryRun: boolean;
	verbose: boolean;
	nulledit: boolean;
	concurrency: number;
}

interface ListResponse {
	query?: Record<string, Array<{ title: string }> | undefined>;
	continue?: Record<string, string | undefined>;
	error?: {
		code: string;
		info: string;
	};
}

function parseArgs(args: string[]): CliArgs | null {
	const result: CliArgs = {
		title: '',
		namespace: 0,
		dryRun: false,
		verbose: false,
		nulledit: false,
		concurrency: 3,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--verbose') {
			result.verbose = true;
		} else if (arg === '--nulledit') {
			result.nulledit = true;
		} else if (arg === '--namespace' && args[i + 1]) {
			result.namespace = parseInt(args[i + 1], 10);
			i++;
		} else if ((arg === '--concurrency' || arg === '-c') && args[i + 1]) {
			result.concurrency = parseInt(args[i + 1], 10);
			i++;
		} else if (!arg.startsWith('--') && !arg.startsWith('-')) {
			result.title = arg;
		}
	}

	if (!result.title) {
		console.error('用法: npx tsx src/purge/PurgeBacklinks.ts <页面标题> [--namespace <ns>] [--nulledit] [--concurrency <n>] [--dry-run] [--verbose]');
		return null;
	}

	return result;
}

type ListType = 'backlinks' | 'embeddedin';

interface ListConfig {
	titleParam: string;
	nsParam: string;
	limitParam: string;
	contParam: string;
	resultKey: string;
}

const LIST_CONFIGS: Record<ListType, ListConfig> = {
	backlinks: {
		titleParam: 'bltitle',
		nsParam: 'blnamespace',
		limitParam: 'bllimit',
		contParam: 'blcontinue',
		resultKey: 'backlinks',
	},
	embeddedin: {
		titleParam: 'eititle',
		nsParam: 'einamespace',
		limitParam: 'eilimit',
		contParam: 'eicontinue',
		resultKey: 'embeddedin',
	},
};

async function collectPages(
	api: MediaWikiApi,
	listType: ListType,
	titleValue: string,
	namespace: number,
	verbose: boolean,
): Promise<string[]> {
	const result: string[] = [];
	const eol = Symbol();
	let continueParam: string | symbol | undefined = undefined;
	let genericContinue: string | undefined;
	const { titleParam, nsParam, limitParam, contParam, resultKey } = LIST_CONFIGS[listType];

	while (continueParam !== eol) {
		const params: Record<string, string | number | undefined> = {
			action: 'query',
			formatversion: '2',
			list: listType,
			[titleParam]: titleValue,
			[nsParam]: namespace,
			[limitParam]: 'max',
		};
		if (typeof continueParam === 'string') {
			params[contParam] = continueParam;
		}
		if (genericContinue !== undefined) {
			params.continue = genericContinue;
		}

		const { data } = await api.post<ListResponse>(params, {
			retry: 15,
		} as any);

		if (data.error !== undefined) {
			console.error(`[${listType}] API 错误: ${data.error.code} — ${data.error.info}`);
			break;
		}

		if (data.query === undefined) {
			break;
		}

		continueParam = data.continue?.[contParam] ?? eol;
		genericContinue = data.continue?.continue;

		const items = data.query[resultKey];
		if (items !== undefined) {
			result.push(...items.map((p) => p.title));
		}

		if (verbose) {
			console.log(
				`[${listType}] ${contParam}: ${continueParam === eol ? 'END' : String(continueParam)}, 已收集 ${result.length} 个页面`,
			);
		}

		if (continueParam !== eol) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		}
	}

	return result;
}

function deduplicate(pages: string[]): string[] {
	return [...new Set(pages)];
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
	delayMs: number,
): Promise<{ success: number; fail: number }> {
	let success = 0;
	let fail = 0;
	let index = 0;

	async function workerLoop() {
		while (index < items.length) {
			const i = index++;
			try {
				await worker(items[i]);
				success++;
			} catch {
				fail++;
			}
			if (delayMs > 0 && index < items.length) {
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => workerLoop(),
	);
	await Promise.all(workers);

	return { success, fail };
}

async function purgePages(
	api: MediaWikiApi,
	pages: string[],
	dryRun: boolean,
	verbose: boolean,
	concurrency: number,
): Promise<{ success: number; fail: number }> {
	const BATCH_SIZE = 50;
	const batches: string[][] = [];
	for (let i = 0; i < pages.length; i += BATCH_SIZE) {
		batches.push(pages.slice(i, i + BATCH_SIZE));
	}

	const { success: batchSuccess, fail: batchFail } = await runWithConcurrency(
		batches,
		concurrency,
		async (batch) => {
			const titles = batch.join('|');

			if (dryRun) {
				console.log(`[DRY-RUN] 将 purge: ${titles}`);
				return;
			}

			await api.post({
				action: 'purge',
				titles,
				format: 'json',
			});
			if (verbose) {
				console.log(`[PURGE] 已刷新 ${batch.length} 个页面`);
			}
		},
		1000,
	);

	const success = batchSuccess * BATCH_SIZE;
	const fail = batchFail * BATCH_SIZE;
	return { success, fail };
}

async function nulleditPages(
	api: MediaWikiApi,
	pages: string[],
	dryRun: boolean,
	verbose: boolean,
	concurrency: number,
): Promise<{ success: number; fail: number }> {
	return runWithConcurrency(
		pages,
		concurrency,
		async (title) => {
			if (dryRun) {
				console.log(`[DRY-RUN] 将零编辑: ${title}`);
				return;
			}

			await api.postWithEditToken({
				action: 'edit',
				title,
				appendtext: "",
				summary: '零编辑：刷新页面缓存',
				bot: true,
				notminor: true,
				tags: 'Bot',
				watchlist: 'nochange',
			});

			if (verbose) {
				console.log(`[NULLEDIT] ${title}`);
			}
		},
		1000,
	);
}

const api = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie! },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const cliArgs = parseArgs(process.argv.slice(2));
	if (!cliArgs) {
		process.exit(1);
	}

	const { title, namespace, dryRun, verbose, nulledit, concurrency } = cliArgs;
	console.log(`目标页面: ${title}`);
	console.log(`命名空间: ${namespace}`);
	console.log(`并发数: ${concurrency}`);
	console.log(`模式: ${dryRun ? 'DRY-RUN' : '正式执行'}`);
	console.log(`方式: ${nulledit ? '零编辑 (null edit)' : 'Purge'}`);

	await clientlogin(api, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!)
		.then((result) => { console.log(result); });

	// 收集链入页面
	console.log('\n=== 收集链入页面 (backlinks) ===');
	const backlinks = await collectPages(api, 'backlinks', title, namespace, verbose);
	console.log(`链入页面: ${backlinks.length} 个`);

	// 收集嵌入页面
	console.log('\n=== 收集嵌入页面 (embeddedin) ===');
	const embedded = await collectPages(api, 'embeddedin', title, namespace, verbose);
	console.log(`嵌入页面: ${embedded.length} 个`);

	// 去重合并
	const allPages = deduplicate([...backlinks, ...embedded]);
	console.log(`\n去重后总计: ${allPages.length} 个页面`);

	if (allPages.length === 0) {
		console.log('没有找到任何链入/嵌入页面，退出。');
		console.log(`End time: ${new Date().toISOString()}`);
		return;
	}

	// 执行刷新
	console.log(`\n=== 刷新缓存 (${nulledit ? 'null edit' : 'purge'}) ===`);
	const { success, fail } = nulledit
		? await nulleditPages(api, allPages, dryRun, verbose, concurrency)
		: await purgePages(api, allPages, dryRun, verbose, concurrency);

	// 汇总
	console.log('\n=== 汇总 ===');
	console.log(`链入页面数: ${backlinks.length}`);
	console.log(`嵌入页面数: ${embedded.length}`);
	console.log(`去重后总数: ${allPages.length}`);
	console.log(`成功: ${success}`);
	console.log(`失败: ${fail}`);
	console.log(`End time: ${new Date().toISOString()}`);
})();
