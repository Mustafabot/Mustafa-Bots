import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import process from 'process';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

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

Parser.config = 'moegirl';

const zhApi = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie! },
});

const cmApi = new MediaWikiApi(config.cm.api, {
	headers: { cookie: config.cm.cookie! },
});

const MAX_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：还原被删除的文件';
const CONFIG_PAGE = 'User:没有羽翼的格雷塔/BotConfig/FileRestore';

async function fetchFileList(api: MediaWikiApi, pageTitle: string): Promise<string[]> {
	const { data } = await api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: pageTitle,
	}, {
		retry: 15,
	} as Parameters<typeof api.post>[1]);

	const pages = data.query.pages as Record<string, { revisions?: { content: string }[] }>;
	const page = Object.values(pages)[0];
	if (!page || !page.revisions) {
		throw new Error(`配置页面 "${pageTitle}" 不存在或无法获取内容`);
	}

	const content = page.revisions[0].content;
	const parsed = Parser.parse(content, pageTitle);
	const poemNodes = parsed.querySelectorAll('ext#poem') as any[];

	if (poemNodes.length === 0) {
		throw new Error(`配置页面 "${pageTitle}" 中未找到 <poem> 标签`);
	}

	const filenames: string[] = [];
	for (const node of poemNodes) {
		const innerText: string | undefined = node.innerText;
		if (!innerText) continue;
		for (const line of innerText.split('\n')) {
			const trimmed = line.trim();
			if (trimmed) {
				filenames.push(trimmed);
			}
		}
	}

	return [...new Set(filenames)];
}

async function clearPoemQueue(api: MediaWikiApi, pageTitle: string): Promise<void> {
	const { data } = await api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: pageTitle,
	}, {
		retry: 15,
	} as Parameters<typeof api.post>[1]);

	const pages = data.query.pages as Record<string, { revisions?: { content: string }[] }>;
	const page = Object.values(pages)[0];
	if (!page || !page.revisions) {
		console.error('  无法读取配置页面内容，跳过清空队列');
		return;
	}

	const content = page.revisions[0].content;
	const parsed = Parser.parse(content, pageTitle);
	const poemNodes = parsed.querySelectorAll('ext#poem') as Array<{ innerText: string }>;

	if (poemNodes.length === 0) {
		console.log('  配置页面中无 poem 标签，无需清空');
		return;
	}

	for (const node of poemNodes) {
		node.innerText = '';
	}

	const newContent = parsed.toString();

	await api.postWithToken('csrf', {
		action: 'edit',
		title: pageTitle,
		text: newContent,
		summary: '机器人：清空还原队列',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}, {
		retry: 500,
		noCache: true,
	});

	console.log('  队列已清空');
}

async function fetchDeletedRevisions(
	api: MediaWikiApi,
	title: string,
): Promise<Array<{ revid: number; user: string; comment: string; timestamp: string }>> {
	const { data } = await api.post({
		action: 'query',
		list: 'deletedrevs',
		drtitle: title,
		drprop: 'revid|user|comment|timestamp',
		drlimit: 50,
	}, {
		retry: 15,
	} as Parameters<typeof api.post>[1]);

	const deletedrevs = (data.query as any).deletedrevs;
	if (!deletedrevs || !Array.isArray(deletedrevs) || deletedrevs.length === 0) {
		return [];
	}

	return deletedrevs[0].revisions || [];
}

async function undeleteFile(
	api: MediaWikiApi,
	title: string,
	comment: string,
): Promise<{ success: boolean; error?: string }> {
	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await api.postWithToken('csrf', {
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

			if ((data as any).undelete && (data as any).undelete.file_versions !== undefined) {
				return { success: true };
			}

			if ((data as any).undelete) {
				return { success: true };
			}

			if (JSON.stringify(data).includes('moderation-move-queued')) {
				console.log('  还原请求已进入审核队列，视为成功');
				return { success: true };
			}

			throw new Error(JSON.stringify(data));
		} catch (error: any) {
			const errMsg = error?.message || String(error);
			lastError = error;
			if (attempt < MAX_RETRIES) {
				console.log(`  还原失败（${errMsg}），第${attempt}次重试...`);
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
): Promise<{ success: boolean; error?: string; noEdits?: boolean }> {
	let revisions: Array<{ revid: number; user: string; comment: string }>;

	try {
		const { data } = await api.post({
			action: 'query',
			prop: 'revisions',
			rvprop: 'ids|user|comment',
			rvlimit: 2,
			titles: title,
		}, {
			retry: 15,
		} as Parameters<typeof api.post>[1]);

		const pages = (data.query as any).pages;
		const page = Object.values(pages)[0] as any;
		if (!page || !page.revisions || page.revisions.length === 0) {
			return { success: false, error: '页面无修订记录', noEdits: true };
		}

		revisions = page.revisions;
	} catch (error: any) {
		return { success: false, error: `查询修订失败: ${error.message}` };
	}

	if (revisions.length < 2) {
		return { success: false, error: '仅有一个修订，无法撤销', noEdits: true };
	}

	const lastRevId = revisions[0].revid;
	const lastRevUser = revisions[0].user;
	const lastRevComment = revisions[0].comment;

	console.log(`  最后一笔编辑: revid=${lastRevId}, user=${lastRevUser}, comment=${lastRevComment || '(无)'}`);

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await api.postWithToken('csrf', {
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

			if ((data as any).edit && (data as any).edit.result === 'Success') {
				return { success: true };
			}

			if ((data as any).edit && (data as any).edit.captcha) {
				return { success: false, error: '需要验证码，无法自动撤销' };
			}

			throw new Error(JSON.stringify(data));
		} catch (error: any) {
			const errMsg = error?.message || String(error);
			if (errMsg.includes('moderation')) {
				console.log('  撤销编辑请求已进入审核队列，视为成功');
				return { success: true };
			}
			if (errMsg.includes('undo-failure')) {
				return { success: false, error: '撤销冲突：中间有其他编辑，无法自动撤销' };
			}
			lastError = error;
			if (attempt < MAX_RETRIES) {
				console.log(`  撤销编辑失败（${errMsg}），第${attempt}次重试...`);
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
	index: number,
	total: number,
): Promise<RestoreResult> {
	const filename = rawFilename.startsWith('File:')
		? rawFilename
		: `File:${rawFilename}`;

	console.log(`\n[${index}/${total}] 处理: ${filename}`);

	const result: RestoreResult = {
		filename,
		undeleteSuccess: false,
		undoSuccess: false,
		skipped: false,
	};

	const deletedRevisions = await fetchDeletedRevisions(api, filename);
	if (deletedRevisions.length === 0) {
		console.log('  页面不在删除记录中，跳过');
		result.skipped = true;
		result.skipReason = '页面不在删除记录中';
		return result;
	}

	console.log(`  删除修订数: ${deletedRevisions.length}`);

	if (options.dryRun) {
		console.log('  [试运行] 将还原此文件');
		if (!options.noUndoEdit) {
			console.log('  [试运行] 将在还原后撤销最后一笔编辑');
		}
		result.skipped = true;
		result.skipReason = '试运行模式';
		return result;
	}

	console.log(`  还原文件...`);
	const undeleteResult = await undeleteFile(api, filename, comment);
	if (!undeleteResult.success) {
		console.error(`  还原失败: ${undeleteResult.error}`);
		result.undeleteError = undeleteResult.error;
		return result;
	}

	result.undeleteSuccess = true;
	console.log('  还原成功');

	if (options.noUndoEdit) {
		console.log('  跳过撤销最后一笔编辑（--no-undo-edit）');
		result.undoSuccess = true;
		return result;
	}

	console.log('  撤销最后一笔编辑...');
	await new Promise(resolve => setTimeout(resolve, 500));

	const undoResult = await undoLastEdit(api, filename, comment);
	if (undoResult.noEdits) {
		console.log(`  无法撤销: ${undoResult.error}`);
		result.undoSuccess = true;
	} else if (!undoResult.success) {
		console.error(`  撤销失败: ${undoResult.error}`);
		result.undoError = undoResult.error;
	} else {
		result.undoSuccess = true;
		console.log('  撤销成功');
	}

	return result;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		dryRun: false,
		verbose: false,
		noUndoEdit: false,
	};

	for (const arg of args) {
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--verbose') {
			result.verbose = true;
		} else if (arg === '--no-undo-edit') {
			result.noUndoEdit = true;
		}
	}

	return result;
}

async function main(): Promise<void> {
	console.log(`Start time: ${new Date().toISOString()}`);

	const args = parseArgs(process.argv.slice(2));

	console.log('正在登录zh站...');
	await clientlogin(zhApi, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!)
		.then((result) => { console.log('zh站登录成功', result); });

	console.log('正在登录commons站...');
	await clientlogin(cmApi, config.cm.bot.clientUsername!, config.cm.bot.clientPassword!, config.cm.api)
		.then((result) => { console.log('commons站登录成功', result); });

	console.log(`\n正在读取配置页面: ${CONFIG_PAGE}`);
	let filenames: string[];
	try {
		filenames = await fetchFileList(zhApi, CONFIG_PAGE);
	} catch (error) {
		console.error(`读取配置失败: ${(error as Error).message}`);
		process.exit(1);
	}

	if (filenames.length === 0) {
		console.error('配置中未找到待还原的文件');
		process.exit(1);
	}

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
		const result = await processFile(cmApi, filenames[i], comment, args, i + 1, total);
		results.push(result);
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

	console.log('\n正在清空队列...');
	if (!args.dryRun) {
		await clearPoemQueue(zhApi, CONFIG_PAGE);
	} else {
		console.log('  [试运行模式] 不清空队列');
	}

	console.log(`\nEnd time: ${new Date().toISOString()}`);
}

main().catch((error: unknown) => {
	console.error('发生错误:', error);
	process.exit(1);
});
