import { MediaWikiApi } from 'wiki-saikou';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'fs';
import { extname, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createCmApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { withApiRetry, checkModerationQueued, checkModerationQueuedError } from '../utils/retry.js';
import { createEmitter } from '../core/progress.js';
import {
	parseUploadConfig,
	validateUploadConfig,
	targetFilename,
	normalizeFileTitle,
	generateFilePageText,
	generateUploadComment,
	type LocalFileProbe,
	type UploadFileEntry,
	type UploadTaskConfig,
} from './uploadConfig.js';

interface UploadResult {
	filename: string;
	url: string;
	success: boolean;
	error?: string;
}

interface CliArgs {
	configFile: string;
	dryRun: boolean;
	verbose: boolean;
	/** 只查线上是否存在，不上传 */
	checkOnly: boolean;
	/** 只上传线上不存在的 */
	onlyMissing: boolean;
}

const cmApi = createCmApi();

const MAX_RETRIES = 3;

const USAGE = '用法: npx tsx src/upload/UrlUpload.ts --config-file <本地配置 JSON> [--check] [--only-missing] [--dry-run] [--quiet]';
/** 逐条人类日志的开关，由 --quiet 关掉；GUI 拉起的任务一律带 --quiet */
let verbose = true;
function log(message: string): void {
	if (verbose) console.log(message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMP_DIR = resolve(__dirname, '../../temp');

/** 读本地配置文件；不存在时给出可执行的提示 */
function readLocalConfig(path: string): UploadTaskConfig {
	const absolute = resolve(path);
	if (!existsSync(absolute)) throw new Error(`配置文件不存在：${absolute}`);
	try {
		return parseUploadConfig(readFileSync(absolute, 'utf-8'));
	} catch (error) {
		// `cause` 必须带：仓库的 eslint 开了 preserve-caught-error，不带会报 error
		throw new Error(`配置文件 ${absolute} 有误：${(error as Error).message}`, { cause: error });
	}
}

/** 探测本机文件：不存在或读不到大小都如实返回，交给校验判断 */
const probeLocalFile: LocalFileProbe = (path) => {
	try {
		return { exists: true, size: statSync(path).size };
	} catch {
		return { exists: false, size: null };
	}
};

function ensureTempDir(): void {
	if (!existsSync(TEMP_DIR)) {
		mkdirSync(TEMP_DIR, { recursive: true });
	}
}

function cleanupTempFile(filePath: string): void {
	try {
		if (existsSync(filePath)) {
			unlinkSync(filePath);
		}
	} catch (error) {
		console.error(`  清理临时文件失败: ${filePath}`, error);
	}
}

function cleanupTempDir(): void {
	try {
		if (existsSync(TEMP_DIR)) {
			const files = readdirSync(TEMP_DIR);
			for (const file of files) {
				const filePath = resolve(TEMP_DIR, file);
				unlinkSync(filePath);
			}
			console.log(`  已清理临时目录: ${TEMP_DIR}`);
		}
	} catch (error) {
		console.error('  清理临时目录失败:', error);
	}
}

async function downloadImage(url: string, filePath: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			'User-Agent': config.userAgent,
		},
	});
	if (!response.ok) {
		throw new Error(`下载失败: HTTP ${response.status}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	writeFileSync(filePath, buffer);
	const contentType = response.headers.get('content-type');
	const mimeType = contentType ? contentType.split(';')[0].trim().toLowerCase() : 'image/png';
	return mimeType;
}

/** 一条上传涉及的目标文件名、正文与摘要，算一次用到底 */
interface ResolvedEntry {
	filename: string;
	text: string;
	comment: string;
}

function resolveEntry(uploadConfig: UploadTaskConfig, entry: UploadFileEntry): ResolvedEntry {
	const filename = targetFilename(uploadConfig, entry);
	return {
		filename,
		text: generateFilePageText(uploadConfig, entry),
		comment: generateUploadComment(uploadConfig, entry),
	};
}

const MIME_BY_EXTENSION: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.pdf': 'application/pdf',
};

/** 本机文件按扩展名推 MIME；认不出的交给服务端判 */
function mimeTypeForLocalFile(path: string): string {
	return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function uploadFromFile(
	api: MediaWikiApi,
	filePath: string,
	resolved: ResolvedEntry,
	mimeType: string,
	dryRun: boolean
): Promise<UploadResult> {
	const { filename, comment, text } = resolved;
	if (dryRun) {
		log(`  [试运行] 将从本地上传: ${filename}`);
		return { filename, url: `file://${filePath}`, success: true };
	}

	const fileBuffer = readFileSync(filePath);
	const file = new File([fileBuffer], filename.replace(/^File:/i, ''), { type: mimeType });

	try {
		return await withApiRetry(
			() => api.postWithToken('csrf', {
				action: 'upload',
				filename,
				file,
				comment,
				text,
				ignorewarnings: true,
				bot: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 500,
				noCache: true,
			}),
			{
				maxRetries: MAX_RETRIES,
				baseDelay: 1000,
				onSuccess: (data) => {
					if (data.upload && data.upload.result === 'Success') {
						return { filename, url: `file://${filePath}`, success: true };
					}

					if (checkModerationQueued(data, '  文件已进入审核队列')) {
						return { filename, url: `file://${filePath}`, success: true };
					}

					return null;
				},
				onError: (error, attempt) => {
					if (checkModerationQueuedError(error, '  文件已进入审核队列')) {
						throw error;
					}
					log(`  本地上传失败（${error.message}），第${attempt}次重试...`);
				},
				shouldRetry: () => true
			}
		);
	} catch (error: any) {
		return {
			filename,
			url: `file://${filePath}`,
			success: false,
			error: error?.message || '未知错误',
		};
	}
}

async function uploadFromUrl(api: MediaWikiApi, entry: UploadFileEntry, resolved: ResolvedEntry, dryRun: boolean): Promise<UploadResult> {
	const { filename, comment, text } = resolved;
	const sourceUrl = entry.url!;

	if (dryRun) {
		log('  [试运行模式] 跳过实际上传');
		return {
			filename,
			url: sourceUrl,
			success: true,
		};
	}

	try {
		const result = await withApiRetry(
			() => api.postWithToken('csrf', {
				action: 'upload',
				filename,
				url: sourceUrl,
				comment,
				text,
				ignorewarnings: true,
				bot: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 500,
				noCache: true,
			}),
			{
				maxRetries: MAX_RETRIES,
				baseDelay: 1000,
				onSuccess: (data) => {
					if (data.upload && data.upload.result === 'Success') {
						if (data.upload.warnings) {
							log('  警告: 文件已存在，已被覆盖');
						}
						return {
							filename,
							url: sourceUrl,
							success: true,
						};
					}

					if (checkModerationQueued(data, '  文件已进入审核队列')) {
						return {
							filename,
							url: sourceUrl,
							success: true,
						};
					}

					return null;
				},
				onError: (error, attempt) => {
					if (checkModerationQueuedError(error, '  文件已进入审核队列')) {
						throw error;
					}
					log(`  上传失败（${error.message}），第${attempt}次重试...`);
				},
				shouldRetry: () => true
			}
		);

		return result;
	} catch (error: any) {
		const errorMessage = error?.message || '';
		if (errorMessage.includes('moderation-image-queued')) {
			log('  文件已进入审核队列');
			return {
				filename,
				url: sourceUrl,
				success: true,
			};
		}
		if (errorMessage.includes('http-bad-status')) {
			log('  URL上传失败，尝试本地下载后上传...');
			ensureTempDir();
			const sanitizedFilename = filename.replace(/[<>:"/\\|?*]/g, '_');
			const tempFilePath = resolve(TEMP_DIR, `${Date.now()}_${sanitizedFilename.replace(/^File:/i, '')}`);

			try {
				const mimeType = await downloadImage(sourceUrl, tempFilePath);
				const uploadResult = await uploadFromFile(api, tempFilePath, resolved, mimeType, dryRun);
				return uploadResult;
			} catch (downloadError: any) {
				log(`  本地下载上传失败: ${downloadError.message}`);
				return {
					filename,
					url: sourceUrl,
					success: false,
					error: `URL上传失败且备用渠道失败: ${errorMessage}; 备用渠道: ${downloadError.message}`,
				};
			} finally {
				cleanupTempFile(tempFilePath);
			}
		}

		return {
			filename,
			url: sourceUrl,
			success: false,
			error: errorMessage || '未知错误',
		};
	}
}

/** 按条目来源分派：本机文件走 uploadFromFile，外站地址走 uploadFromUrl */
async function uploadOne(api: MediaWikiApi, uploadConfig: UploadTaskConfig, entry: UploadFileEntry, dryRun: boolean): Promise<UploadResult> {
	const resolved = resolveEntry(uploadConfig, entry);
	log(`  目标文件名: ${resolved.filename}`);
	if (entry.file !== undefined) {
		log(`  来源文件: ${entry.file}`);
		return uploadFromFile(api, entry.file, resolved, mimeTypeForLocalFile(entry.file), dryRun);
	}
	log(`  来源URL: ${entry.url}`);
	return uploadFromUrl(api, entry, resolved, dryRun);
}

/** 一次查询能带的标题数上限 */
const MAX_TITLES_PER_QUERY = 50;

/**
 * 查这些目标文件名在共享站上存在与否。
 * 标题按 MediaWiki 的规则归一后当键，避免"首字母大写""下划线当空格"造成的假阴性。
 */
async function checkExisting(api: MediaWikiApi, filenames: string[]): Promise<Map<string, boolean>> {
	const result = new Map<string, boolean>();
	for (let offset = 0; offset < filenames.length; offset += MAX_TITLES_PER_QUERY) {
		const batch = filenames.slice(offset, offset + MAX_TITLES_PER_QUERY);
		const { data } = await api.post<{ query?: { pages?: Array<{ title?: string; missing?: unknown }> } }>({
			action: 'query',
			prop: 'info',
			titles: batch.map((name) => `File:${name}`).join('|'),
		}, { retry: 15 } as any);
		for (const page of data.query?.pages ?? []) {
			const title = typeof page.title === 'string' ? page.title : '';
			if (title === '') continue;
			result.set(normalizeFileTitle(title), page.missing === undefined);
		}
	}
	return result;
}

function parseArgs(args: string[]): CliArgs | null {
	const result: CliArgs = { configFile: '', dryRun: false, verbose: true, checkOnly: false, onlyMissing: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') result.dryRun = true;
		else if (arg === '--quiet') result.verbose = false;
		else if (arg === '--check') result.checkOnly = true;
		else if (arg === '--only-missing') result.onlyMissing = true;
		else if (arg === '--config-file' && args[i + 1] !== undefined) {
			result.configFile = args[i + 1];
			i++;
		}
	}
	if (result.configFile === '') {
		console.error(USAGE);
		return null;
	}
	return result;
}

async function main(): Promise<void> {
	console.log(`Start time: ${new Date().toISOString()}`);

	const args = parseArgs(process.argv.slice(2));
	if (args === null) process.exit(1);
	verbose = args.verbose;

	const emit = createEmitter(process.argv.includes('--progress-json'));
	emit({ type: 'start', task: 'URL 上传' });

	cleanupTempDir();

	let uploadConfig: UploadTaskConfig;
	try {
		uploadConfig = readLocalConfig(args.configFile);
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}

	const issues = validateUploadConfig(uploadConfig, probeLocalFile);
	if (issues.length > 0) {
		console.error('配置校验失败：');
		for (const issue of issues) console.error(`  - ${issue.message}`);
		process.exit(1);
	}

	log(`配置解析成功，共 ${uploadConfig.files.length} 个文件待上传`);
	if (args.dryRun) log('[试运行模式] 不会实际上传文件');

	console.log('正在登录commons站...');
	await clientlogin(cmApi, config.cm.bot.clientUsername!, config.cm.bot.clientPassword!, config.cm.api)
		.then((result) => { log(`commons站登录成功 ${result}`); });

	if (args.checkOnly) {
		emit({ type: 'phase', name: '检查线上状态' });
		const names = uploadConfig.files.map((entry) => targetFilename(uploadConfig, entry));
		const existing = await checkExisting(cmApi, names);
		for (const [index, name] of names.entries()) {
			const exists = existing.get(normalizeFileTitle(name)) === true;
			emit({ type: 'detail', title: `File:${name}`, fields: { 线上状态: exists ? '已存在' : '不存在' } });
			emit({ type: 'progress', done: index + 1, total: names.length, message: '已检查' });
			log(`${name}: ${exists ? '已存在' : '不存在'}`);
		}
		emit({ type: 'done', summary: { checked: names.length } });
		return;
	}

	let targets = uploadConfig.files;
	if (args.onlyMissing) {
		emit({ type: 'phase', name: '检查线上状态' });
		const existing = await checkExisting(cmApi, uploadConfig.files.map((entry) => targetFilename(uploadConfig, entry)));
		const skipped: string[] = [];
		targets = uploadConfig.files.filter((entry) => {
			const name = targetFilename(uploadConfig, entry);
			if (existing.get(normalizeFileTitle(name)) === true) {
				skipped.push(name);
				return false;
			}
			return true;
		});
		for (const name of skipped) {
			emit({ type: 'edit', title: `File:${name}`, status: 'skipped', oldRevid: null, newRevid: null, message: '线上已存在，差分上传跳过' });
			log(`跳过（线上已存在）: ${name}`);
		}
		log(`差分上传：跳过 ${skipped.length} 个，待上传 ${targets.length} 个`);
		if (targets.length === 0) {
			emit({ type: 'done', summary: { changed: 0, skipped: skipped.length, failed: 0 } });
			console.log('差分上传：没有需要上传的文件');
			return;
		}
	}

	emit({ type: 'phase', name: '上传' });
	const results: UploadResult[] = [];
	const skippedCount = uploadConfig.files.length - targets.length;
	const total = targets.length;
	for (const [position, entry] of targets.entries()) {
		const name = targetFilename(uploadConfig, entry);
		log(`\n[${position + 1}/${total}] 正在上传: ${name}`);
		const result = await uploadOne(cmApi, uploadConfig, entry, args.dryRun);
		results.push(result);
		emit({
			type: 'edit',
			title: `File:${result.filename}`,
			status: result.success ? 'changed' : 'failed',
			oldRevid: null,
			newRevid: null,
			message: result.success ? (args.dryRun ? '[DRY-RUN] 将上传' : '上传成功') : `上传失败：${result.error ?? '未知错误'}`,
		});
		emit({ type: 'progress', done: position + 1, total, message: '已上传' });
		if (result.success) log('  上传成功！');
		else console.error(`  上传失败: ${result.error}`);
	}

	emit({
		type: 'done',
		summary: {
			changed: results.filter((r) => r.success).length,
			skipped: skippedCount,
			failed: results.filter((r) => !r.success).length,
		},
	});

	const successCount = results.filter((r) => r.success).length;
	const failCount = results.filter((r) => !r.success).length;

	console.log('\n上传完成！');
	console.log(`成功: ${successCount} 个`);
	console.log(`失败: ${failCount} 个`);

	if (failCount > 0) {
		console.log('\n失败详情:');
		for (const result of results.filter((r) => !r.success)) {
			console.log(`  - ${result.filename}: ${result.error}`);
		}
	}

	console.log(`\nEnd time: ${new Date().toISOString()}`);
}

main().catch((error: unknown) => {
	console.error('发生错误:', error);
	process.exit(1);
});
