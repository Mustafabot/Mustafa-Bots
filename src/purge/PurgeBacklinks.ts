import { MediaWikiApi } from 'wiki-saikou';
import type { ApiQueryResponse } from 'types-mediawiki-response';
import { createZhApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { createEmitter, type EmitProgress } from '../core/progress.js';
import { parseArgs, USAGE } from './purgeArgs.js';

interface ListResponse extends ApiQueryResponse {
	error?: {
		code: string;
		info: string;
	};
}

type ListType = 'backlinks' | 'embeddedin';

interface ListConfig {
	titleParam: string;
	limitParam: string;
	contParam: string;
	resultKey: 'backlinks' | 'embeddedin';
}

const LIST_CONFIGS: Record<ListType, ListConfig> = {
	backlinks: {
		titleParam: 'bltitle',
		limitParam: 'bllimit',
		contParam: 'blcontinue',
		resultKey: 'backlinks',
	},
	embeddedin: {
		titleParam: 'eititle',
		limitParam: 'eilimit',
		contParam: 'eicontinue',
		resultKey: 'embeddedin',
	},
};

/** 列表类型在提示语里的中文说法 */
const LIST_LABELS: Record<ListType, string> = {
	backlinks: '链入页面',
	embeddedin: '嵌入页面',
};

async function collectPages(
	api: MediaWikiApi,
	listType: ListType,
	titleValue: string,
	verbose: boolean,
	emit: EmitProgress,
): Promise<string[]> {
	const result: string[] = [];
	const eol = Symbol();
	let continueParam: string | symbol | undefined = undefined;
	let genericContinue: string | undefined;
	const { titleParam, limitParam, contParam, resultKey } = LIST_CONFIGS[listType];
	const label = LIST_LABELS[listType];

	while (continueParam !== eol) {
		const params: Record<string, string | number | undefined> = {
			action: 'query',
			formatversion: '2',
			list: listType,
			[titleParam]: titleValue,
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
			// 收集阶段出错时必须让界面看得见：否则任务只是"少了几个页面"，没人会去翻日志
			emit({ type: 'log', level: 'error', message: `收集中断（${label}）：${data.error.code} — ${data.error.info}` });
			break;
		}

		if (data.query === undefined) {
			break;
		}

		continueParam = data.continue?.[contParam] as string | undefined ?? eol;
		genericContinue = data.continue?.continue;

		const items = data.query[resultKey];
		if (items !== undefined) {
			result.push(...items.map((p) => p.title));
		}

		// 链入数量事先未知，故只报已收集数（界面按不定长进度条渲染）
		emit({ type: 'progress', done: result.length, message: `已收集 ${result.length} 个${label}` });

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

/**
 * 以固定并发跑一批条目，收集成功与失败的原始条目。
 *
 * 返回条目本身（而非计数）：刷新是按批发出的，只有拿到批次才能按它的实际页数累计，
 * 早先"成功批数 × 批次大小"的算法会把末尾不满 50 的批次也算成 50 页。
 */
async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
	delayMs: number,
): Promise<{ ok: T[]; failed: T[] }> {
	const ok: T[] = [];
	const failed: T[] = [];
	let index = 0;

	async function workerLoop() {
		while (index < items.length) {
			const i = index++;
			try {
				await worker(items[i]);
				ok.push(items[i]);
			} catch {
				failed.push(items[i]);
			}
			if (delayMs > 0 && index < items.length) {
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}

	const workers = Array.from(
		{ length: Math.max(1, Math.min(concurrency, items.length)) },
		() => workerLoop(),
	);
	await Promise.all(workers);

	return { ok, failed };
}

/** 把失败批次折成一条简短提示，避免整批标题刷屏 */
function describeFailedBatch(batch: string[]): string {
	const head = batch.slice(0, 3).join('、');
	return batch.length > 3 ? `${head} 等 ${batch.length} 页` : head;
}

async function purgePages(
	api: MediaWikiApi,
	pages: string[],
	dryRun: boolean,
	verbose: boolean,
	concurrency: number,
	emit: EmitProgress,
): Promise<{ success: number; fail: number }> {
	const BATCH_SIZE = 50;
	const batches: string[][] = [];
	for (let i = 0; i < pages.length; i += BATCH_SIZE) {
		batches.push(pages.slice(i, i + BATCH_SIZE));
	}

	let processed = 0;
	const { ok, failed } = await runWithConcurrency(
		batches,
		concurrency,
		async (batch) => {
			const titles = batch.join('|');

			if (!dryRun) {
				await api.post({
					action: 'purge',
					titles,
					format: 'json',
				});
			}

			processed += batch.length;
			emit({
				type: 'progress',
				done: processed,
				total: pages.length,
				message: `${dryRun ? '[DRY-RUN] 计划刷新' : '已刷新'} ${processed}/${pages.length} 页`,
			});
			if (verbose) {
				console.log(dryRun ? `[DRY-RUN] 将 purge: ${titles}` : `[PURGE] 已刷新 ${batch.length} 个页面`);
			}
		},
		1000,
	);

	for (const batch of failed) {
		emit({ type: 'log', level: 'warn', message: `刷新失败：${describeFailedBatch(batch)}` });
	}

	return {
		success: ok.reduce((sum, batch) => sum + batch.length, 0),
		fail: failed.reduce((sum, batch) => sum + batch.length, 0),
	};
}

async function nulleditPages(
	api: MediaWikiApi,
	pages: string[],
	dryRun: boolean,
	verbose: boolean,
	concurrency: number,
	emit: EmitProgress,
): Promise<{ success: number; fail: number }> {
	let processed = 0;
	const { ok, failed } = await runWithConcurrency(
		pages,
		concurrency,
		async (title) => {
			if (!dryRun) {
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
			}

			processed++;
			emit({
				type: 'progress',
				done: processed,
				total: pages.length,
				message: `${dryRun ? '[DRY-RUN] 计划零编辑' : '已零编辑'} ${processed}/${pages.length} 页`,
			});
			if (verbose) {
				console.log(dryRun ? `[DRY-RUN] 将零编辑: ${title}` : `[NULLEDIT] ${title}`);
			}
		},
		1000,
	);

	for (const title of failed) {
		emit({ type: 'log', level: 'warn', message: `零编辑失败：${title}` });
	}

	return { success: ok.length, fail: failed.length };
}

const api = createZhApi();

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	const cliArgs = parseArgs(process.argv.slice(2));
	if (!cliArgs) {
		console.error(USAGE);
		process.exit(1);
	}

	const { title, dryRun, verbose, nulledit, concurrency, progressJson } = cliArgs;
	const emit: EmitProgress = createEmitter(progressJson);
	emit({ type: 'start', task: 'purge-backlinks' });

	console.log(`目标页面: ${title}`);
	console.log(`并发数: ${concurrency}`);
	console.log(`模式: ${dryRun ? 'DRY-RUN' : '正式执行'}`);
	console.log(`方式: ${nulledit ? '零编辑 (null edit)' : 'Purge'}`);

	await clientlogin(api, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!)
		.then((result) => { console.log(result); });

	// 收集链入页面
	console.log('\n=== 收集链入页面 (backlinks) ===');
	emit({ type: 'phase', name: '收集链入页面' });
	const backlinks = await collectPages(api, 'backlinks', title, verbose, emit);
	console.log(`链入页面: ${backlinks.length} 个`);

	// 收集嵌入页面
	console.log('\n=== 收集嵌入页面 (embeddedin) ===');
	emit({ type: 'phase', name: '收集嵌入页面' });
	const embedded = await collectPages(api, 'embeddedin', title, verbose, emit);
	console.log(`嵌入页面: ${embedded.length} 个`);

	// 去重合并
	const allPages = deduplicate([...backlinks, ...embedded]);
	console.log(`\n去重后总计: ${allPages.length} 个页面`);

	if (allPages.length === 0) {
		console.log('没有找到任何链入/嵌入页面，退出。');
		// 此前这里直接 return，done 事件缺失，界面会拿"全零兜底摘要"——
		// 数字碰巧一样，但少了这句警告，用户会以为任务没跑起来
		emit({ type: 'log', level: 'warn', message: `没有找到任何链入或嵌入「${title}」的页面` });
		emit({ type: 'done', summary: { 链入: 0, 嵌入: 0, 去重后: 0, 成功: 0, 失败: 0 } });
		console.log(`End time: ${new Date().toISOString()}`);
		return;
	}

	// 执行刷新
	console.log(`\n=== 刷新缓存 (${nulledit ? 'null edit' : 'purge'}) ===`);
	emit({ type: 'phase', name: nulledit ? '刷新缓存（零编辑）' : '刷新缓存（purge）' });
	const { success, fail } = nulledit
		? await nulleditPages(api, allPages, dryRun, verbose, concurrency, emit)
		: await purgePages(api, allPages, dryRun, verbose, concurrency, emit);

	// 汇总
	console.log('\n=== 汇总 ===');
	console.log(`链入页面数: ${backlinks.length}`);
	console.log(`嵌入页面数: ${embedded.length}`);
	console.log(`去重后总数: ${allPages.length}`);
	console.log(`成功: ${success}`);
	console.log(`失败: ${fail}`);
	console.log(`End time: ${new Date().toISOString()}`);

	emit({
		type: 'done',
		summary: {
			链入: backlinks.length,
			嵌入: embedded.length,
			去重后: allPages.length,
			成功: success,
			失败: fail,
			...(dryRun ? { 空跑: 1 } : {}),
		},
	});
})();
