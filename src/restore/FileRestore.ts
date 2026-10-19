import { MediaWikiApi } from 'wiki-saikou';
import type { ApiEditResponse, ApiPage, ApiQueryResponse, ApiUndeleteResponse } from 'types-mediawiki-response';
import process from 'process';
import { createZhApi, createCmApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { QUEUE_PAGE, parseQueue, renderQueue } from './queueFormat.js';
import { createEmitter, type EmitProgress } from '../core/progress.js';
import { checkModerationQueued, checkModerationQueuedError } from '../utils/retry.js';

interface RestoreResult {
	filename: string;
	undeleteSuccess: boolean;
	undoSuccess: boolean;
	skipped: boolean;
	skipReason?: string;
	undeleteError?: string;
	undoError?: string;
}

interface CliArgs {
	dryRun: boolean;
	verbose: boolean;
	noUndoEdit: boolean;
}

const zhApi = createZhApi();
const cmApi = createCmApi();

const MAX_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：还原被删除的文件';

/** 读队列页：条目、正文与版本号（写回时要用正文做"没变就不写"的比较，用版本号做冲突检测） */
async function fetchQueue(api: MediaWikiApi, pageTitle: string): Promise<{ entries: string[]; content: string; revid: number | null }> {
	const { data } = await api.post<ApiQueryResponse>({
		action: 'query',
		prop: 'revisions',
		rvprop: 'ids|content',
		titles: pageTitle,
	}, {
		retry: 15,
	} as Parameters<typeof api.post>[1]);

	const pages = data.query.pages as ApiPage[];
	const page = Object.values(pages)[0];
	if (!page || !page.revisions) {
		throw new Error(`队列页 "${pageTitle}" 不存在或无法获取内容`);
	}
	const revision = page.revisions[0] as { content?: unknown; revid?: unknown };
	const content = typeof revision.content === 'string' ? revision.content : '';
	const revid = typeof revision.revid === 'number' ? revision.revid : null;
	return { entries: parseQueue(content), content, revid };
}

/** 把剩余条目写回队列页；内容没变就不写 */
async function writeQueue(api: MediaWikiApi, pageTitle: string, entries: string[], originalContent: string): Promise<void> {
	const text = renderQueue(entries);
	if (text === originalContent) {
		console.log('  队列内容没有变化，无需写回');
		return;
	}
	await api.postWithToken('csrf', {
		action: 'edit',
		title: pageTitle,
		text,
		summary: '机器人：更新还原队列',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 500,
		noCache: true,
	});
	console.log('  队列已更新');
}

async function fetchDeletedRevisions(
	api: MediaWikiApi,
	title: string,
): Promise<Array<{ revid: number; user: string; comment: string; timestamp: string }>> {
	const { data } = await api.post<ApiQueryResponse>({
		action: 'query',
		prop: 'deletedrevisions',
		titles: title,
		drvprop: 'ids|user|comment|timestamp',
		drvlimit: 50,
	}, {
		retry: 15,
	} as Parameters<typeof api.post>[1]);

	const pages = (data.query?.pages ?? {}) as ApiPage[];
	const page = Object.values(pages)[0];
	if (!page || !page.deletedrevisions) {
		return [];
	}

	return page.deletedrevisions.map(revision => ({
		revid: revision.revid ?? 0,
		user: revision.user ?? '',
		comment: revision.comment ?? '',
		timestamp: revision.timestamp ?? '',
	}));
}

async function undeleteFile(
	api: MediaWikiApi,
	title: string,
	comment: string,
	verbose: boolean,
): Promise<{ success: boolean; error?: string; noResults?: boolean }> {
	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await api.postWithToken<ApiUndeleteResponse>('csrf', {
				action: 'undelete',
				title,
				reason: comment,
				bot: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 500,
				noCache: true,
			});

			if (data.undelete) {
				return { success: true };
			}

			if (checkModerationQueued(data)) {
				if (verbose) console.log('  还原请求已进入审核队列，视为成功');
				return { success: true };
			}

			if (data.error?.code === 'undelete-no-results') {
				return { success: false, noResults: true };
			}

			throw new Error(JSON.stringify(data));
		} catch (error: any) {
			const errMsg = error?.message || String(error);
			if (errMsg.includes('undelete-no-results')) {
				return { success: false, noResults: true };
			}
			if (checkModerationQueuedError(error)) {
				if (verbose) console.log('  还原请求已进入审核队列，视为成功');
				return { success: true };
			}
			lastError = error;
			if (attempt < MAX_RETRIES) {
				if (verbose) console.log(`  还原失败（${errMsg}），第${attempt}次重试...`);
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
			}
		}
	}

	return { success: false, error: lastError?.message || '未知错误' };
}

async function undoLastEdit(
	api: MediaWikiApi,
	title: string,
	comment: string,
	verbose: boolean,
): Promise<{ success: boolean; error?: string; noEdits?: boolean; undone?: { revid: number; user: string; comment: string } }> {
	let revisions: Array<{ revid: number; user: string; comment: string }>;

	try {
		const { data } = await api.post<ApiQueryResponse>({
			action: 'query',
			prop: 'revisions',
			rvprop: 'ids|user|comment',
			rvlimit: 2,
			titles: title,
		}, {
			retry: 15,
		} as Parameters<typeof api.post>[1]);

		const pages = data.query.pages as ApiPage[];
		const page = Object.values(pages)[0];
		if (!page || !page.revisions || page.revisions.length === 0) {
			return { success: false, error: '页面无修订记录', noEdits: true };
		}

		revisions = page.revisions as Array<{ revid: number; user: string; comment: string }>;
	} catch (error: any) {
		return { success: false, error: `查询修订失败: ${error.message}` };
	}

	if (revisions.length < 2) {
		return { success: false, error: '仅有一个修订，无法撤销', noEdits: true };
	}

	const lastRevId = revisions[0].revid;
	const lastRevUser = revisions[0].user;
	const lastRevComment = revisions[0].comment;

	if (verbose) console.log(`  最后一笔编辑: revid=${lastRevId}, user=${lastRevUser}, comment=${lastRevComment || '(无)'}`);

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await api.postWithToken<ApiEditResponse>('csrf', {
				action: 'edit',
				title,
				undo: lastRevId,
				summary: comment,
				bot: true,
				notminor: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 500,
				noCache: true,
			});

			if (data.edit && data.edit.result === 'Success') {
				return { success: true, undone: { revid: lastRevId, user: lastRevUser, comment: lastRevComment } };
			}

			if ((data as any).edit && (data as any).edit.captcha) {
				return { success: false, error: '需要验证码，无法自动撤销' };
			}

			throw new Error(JSON.stringify(data));
		} catch (error: any) {
			const errMsg = error?.message || String(error);
			if (checkModerationQueuedError(error)) {
				if (verbose) console.log('  撤销编辑请求已进入审核队列，视为成功');
				return { success: true };
			}
			if (errMsg.includes('undo-failure')) {
				return { success: false, error: '撤销冲突：中间有其他编辑，无法自动撤销' };
			}
			lastError = error;
			if (attempt < MAX_RETRIES) {
				if (verbose) console.log(`  撤销编辑失败（${errMsg}），第${attempt}次重试...`);
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
			}
		}
	}

	return { success: false, error: lastError?.message || '未知错误' };
}

async function processFile(
	api: MediaWikiApi,
	rawFilename: string,
	comment: string,
	options: CliArgs,
	emit: EmitProgress,
	index: number,
	total: number,
): Promise<RestoreResult> {
	const filename = rawFilename.startsWith('File:')
		? rawFilename
		: `File:${rawFilename}`;

	const log = (message: string): void => {
		if (options.verbose) console.log(message);
	};

	log(`\n[${index}/${total}] 处理: ${filename}`);

	const result: RestoreResult = {
		filename,
		undeleteSuccess: false,
		undoSuccess: false,
		skipped: false,
	};

	const deletedRevisions = await fetchDeletedRevisions(api, filename);
	if (deletedRevisions.length === 0) {
		log('  页面不在删除记录中，跳过');
		result.skipped = true;
		result.skipReason = '页面不在删除记录中';
		emit({ type: 'detail', title: filename, fields: { 最后编辑者: null, 最后编辑摘要: null, 最后编辑时间: null, 版本数: 0, 可否还原: '不在删除记录中' } });
		emit({ type: 'edit', title: filename, status: 'skipped', oldRevid: null, newRevid: null, message: '页面不在删除记录中' });
		return result;
	}

	const latest = deletedRevisions[0];
	emit({
		type: 'detail',
		title: filename,
		fields: {
			最后编辑者: latest?.user ?? null,
			最后编辑摘要: latest?.comment ?? null,
			最后编辑时间: latest?.timestamp ?? null,
			版本数: deletedRevisions.length,
			可否还原: '可还原',
		},
	});

	log(`  删除修订数: ${deletedRevisions.length}`);

	if (options.dryRun) {
		log('  [试运行] 将还原此文件');
		if (!options.noUndoEdit) {
			log('  [试运行] 将在还原后撤销最后一笔编辑');
		}
		result.skipped = true;
		result.skipReason = '试运行模式';
		emit({ type: 'edit', title: filename, status: 'skipped', oldRevid: null, newRevid: null, message: '[DRY-RUN] 将还原此文件' });
		return result;
	}

	log(`  还原文件...`);
	const undeleteResult = await undeleteFile(api, filename, comment, options.verbose);
	if (!undeleteResult.success) {
		if (undeleteResult.noResults) {
			log('  没有可还原的版本，跳过');
			result.skipped = true;
			result.skipReason = '没有可还原的删除版本';
		} else {
			console.error(`  还原失败: ${undeleteResult.error}`);
			result.undeleteError = undeleteResult.error;
		}
		emit({
			type: 'edit',
			title: filename,
			status: undeleteResult.noResults ? 'skipped' : 'failed',
			oldRevid: null,
			newRevid: null,
			message: undeleteResult.noResults ? '没有可还原的删除版本' : `还原失败：${undeleteResult.error}`,
		});
		return result;
	}

	result.undeleteSuccess = true;
	log('  还原成功');

	if (options.noUndoEdit) {
		log('  跳过撤销最后一笔编辑（--no-undo-edit）');
		result.undoSuccess = true;
		emit({ type: 'edit', title: filename, status: 'changed', oldRevid: null, newRevid: null, message: '还原成功（未撤销编辑）' });
		return result;
	}

	log('  撤销最后一笔编辑...');
	await new Promise(resolve => setTimeout(resolve, 500));

	const undoResult = await undoLastEdit(api, filename, comment, options.verbose);
	if (undoResult.noEdits) {
		log(`  无法撤销: ${undoResult.error}`);
		result.undoSuccess = true;
	} else if (!undoResult.success) {
		console.error(`  撤销失败: ${undoResult.error}`);
		result.undoError = undoResult.error;
	} else {
		result.undoSuccess = true;
		log('  撤销成功');
	}

	const undone = undoResult.undone;
	const detail = undone === undefined ? '' : `，撤销 revid=${undone.revid}（${undone.user}：${undone.comment || '无摘要'}）`;
	emit({
		type: 'edit',
		title: filename,
		status: 'changed',
		oldRevid: null,
		newRevid: null,
		message: result.undoError === undefined ? `还原成功${detail}` : `还原成功，撤销失败：${result.undoError}`,
	});

	return result;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		dryRun: false,
		verbose: true,
		noUndoEdit: false,
	};

	for (const arg of args) {
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--quiet') {
			result.verbose = false;
		} else if (arg === '--no-undo-edit') {
			result.noUndoEdit = true;
		}
	}

	return result;
}

async function main(): Promise<void> {
	console.log(`Start time: ${new Date().toISOString()}`);

	const args = parseArgs(process.argv.slice(2));

	const emit = createEmitter(process.argv.includes('--progress-json'));
	emit({ type: 'start', task: '文件还原' });
	emit({ type: 'phase', name: '读取队列' });

	console.log('正在登录zh站和commons站...');
	const [zhResult, cmResult] = await Promise.all([
		clientlogin(zhApi, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!),
		clientlogin(cmApi, config.cm.bot.clientUsername!, config.cm.bot.clientPassword!, config.cm.api),
	]);
	console.log('zh站登录成功', zhResult);
	console.log('commons站登录成功', cmResult);

	console.log(`\n正在读取队列页: ${QUEUE_PAGE}`);
	let queue: { entries: string[]; content: string; revid: number | null };
	try {
		queue = await fetchQueue(zhApi, QUEUE_PAGE);
	} catch (error) {
		console.error(`读取队列失败: ${(error as Error).message}`);
		process.exit(1);
	}

	if (queue.entries.length === 0) {
		console.error('队列里没有待还原的文件');
		process.exit(1);
	}
	const filenames = queue.entries;

	emit({ type: 'phase', name: '还原' });
	emit({ type: 'progress', done: 0, total: filenames.length, message: '待还原' });

	const comment = DEFAULT_COMMENT;
	const total = filenames.length;

	console.log(`配置解析成功，共 ${total} 个文件待还原`);
	if (args.dryRun) {
		console.log('[试运行模式] 不会实际执行还原和撤销操作');
	}
	if (args.noUndoEdit) {
		console.log('[--no-undo-edit] 还原后不撤销最后一笔编辑');
	}

	const results: RestoreResult[] = [];

	for (let i = 0; i < total; i++) {
		const result = await processFile(cmApi, filenames[i], comment, args, emit, i + 1, total);
		results.push(result);
		emit({ type: 'progress', done: i + 1, total, message: '已处理' });
	}

	const skipped = results.filter(r => r.skipped);
	const undeleteSuccess = results.filter(r => r.undeleteSuccess);
	const undoSuccess = results.filter(r => r.undoSuccess);
	const undeleteFailed = results.filter(r => !r.undeleteSuccess && !r.skipped);
	const undoFailed = results.filter(r => r.undeleteSuccess && !r.undoSuccess);

	console.log('\n========== 处理完成 ==========');
	console.log(`处理文件数: ${total}`);
	console.log(`成功还原: ${undeleteSuccess.length}`);
	console.log(`成功撤销编辑: ${undoSuccess.length}`);
	console.log(`跳过: ${skipped.length}`);
	console.log(`还原失败: ${undeleteFailed.length}`);
	console.log(`撤销编辑失败: ${undoFailed.length}`);

	if (args.verbose) {
		if (undeleteFailed.length > 0) {
			console.log('\n失败的还原:');
			for (const r of undeleteFailed) {
				console.log(`  - ${r.filename}: ${r.undeleteError}`);
			}
		}
		if (undoFailed.length > 0) {
			console.log('\n失败的撤销编辑:');
			for (const r of undoFailed) {
				console.log(`  - ${r.filename}: ${r.undoError}`);
			}
		}
		if (skipped.length > 0) {
			console.log('\n跳过的文件:');
			for (const r of skipped) {
				console.log(`  - ${r.filename}: ${r.skipReason}`);
			}
		}
	}

	emit({
		type: 'done',
		summary: {
			changed: undeleteSuccess.length,
			skipped: skipped.length,
			failed: undeleteFailed.length,
			undoFailed: undoFailed.length,
		},
	});

	console.log('\n正在清空队列...');
	if (!args.dryRun) {
		await writeQueue(zhApi, QUEUE_PAGE, [], queue.content);
	} else {
		console.log('  [试运行模式] 不清空队列');
	}

	console.log(`\nEnd time: ${new Date().toISOString()}`);
}

main().catch((error: unknown) => {
	console.error('发生错误:', error);
	process.exit(1);
});
