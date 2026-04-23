import { MediaWikiApi } from 'wiki-saikou';
import { URL } from 'url';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

interface FileConfig {
	url: string;
	filename?: string;
}

interface UploadConfig {
	files: FileConfig[];
	article?: string;
	comment?: string;
	text?: string;
}

interface UploadResult {
	filename: string;
	url: string;
	success: boolean;
	error?: string;
}

interface ValidationResult {
	valid: boolean;
	errors: string[];
}

interface CliArgs {
	dryRun: boolean;
	verbose: boolean;
}

const zhApi = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie! },
});

const cmApi = new MediaWikiApi(config.cm.api, {
	headers: { cookie: config.cm.cookie! },
});

const MAX_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：自其他网站迁移文件';
const CONFIG_PAGE = 'User:没有羽翼的格雷塔/BotConfig/UrlUpload.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMP_DIR = resolve(__dirname, '../.temp');

async function fetchJsonConfig(api: MediaWikiApi, pageTitle: string): Promise<UploadConfig> {
	const { data } = await api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: pageTitle,
	}, {
		retry: 15,
	} as any);

	const pages = data.query.pages as Record<string, { revisions?: { content: string }[] }>;
	const page = Object.values(pages)[0];
	if (!page || !page.revisions) {
		throw new Error(`配置页面 "${pageTitle}" 不存在或无法获取内容`);
	}

	const content = page.revisions[0].content;
	try {
		return JSON.parse(content) as UploadConfig;
	} catch (e) {
		throw new Error(`JSON解析失败: ${(e as Error).message}`, { cause: e });
	}
}

function validateConfig(uploadConfig: UploadConfig): ValidationResult {
	const errors: string[] = [];

	if (!uploadConfig || typeof uploadConfig !== 'object') {
		errors.push('配置必须是一个对象');
		return { valid: false, errors };
	}

	if (!Array.isArray(uploadConfig.files) || uploadConfig.files.length === 0) {
		errors.push('files必须是非空数组');
		return { valid: false, errors };
	}

	const hasMissingFilename = uploadConfig.files.some(f => !f.filename);
	if (hasMissingFilename && !uploadConfig.article) {
		errors.push('当filename未指定时，article为必填项');
	}

	uploadConfig.files.forEach((file, index) => {
		if (!file.url) {
			errors.push(`files[${index}]: url为必填项`);
		} else {
			try {
				const url = new URL(file.url);
				if (!['http:', 'https:'].includes(url.protocol)) {
					errors.push(`files[${index}]: URL协议必须是http或https`);
				}
			} catch {
				errors.push(`files[${index}]: URL格式无效`);
			}
		}
	});

	return {
		valid: errors.length === 0,
		errors,
	};
}

function extractExtension(url: string): string {
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname;
		const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
		return match ? `.${match[1]}` : '';
	} catch {
		return '';
	}
}

function generateFilename(url: string, article: string, index: number): string {
	const ext = extractExtension(url);
	return `File:${article} ${index}${ext}`;
}

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

async function uploadFromFile(
	api: MediaWikiApi,
	filePath: string,
	filename: string,
	comment: string,
	text: string,
	mimeType: string,
	dryRun: boolean
): Promise<UploadResult> {
	if (dryRun) {
		console.log(`  [试运行] 将从本地上传: ${filename}`);
		return { filename, url: `file://${filePath}`, success: true };
	}

	const fileBuffer = readFileSync(filePath);
	const file = new File([fileBuffer], filename.replace(/^File:/i, ''), { type: mimeType });

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await api.postWithToken('csrf', {
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
			});

			if ((data as any).upload && (data as any).upload.result === 'Success') {
				return { filename, url: `file://${filePath}`, success: true };
			}

			if (JSON.stringify(data).includes('moderation-image-queued')) {
				console.log('  文件已进入审核队列');
				return { filename, url: `file://${filePath}`, success: true };
			}

			throw new Error(JSON.stringify(data));
		} catch (error: any) {
			if (error.message && error.message.includes('moderation-image-queued')) {
				console.log('  文件已进入审核队列');
				return { filename, url: `file://${filePath}`, success: true };
			}
			lastError = error;
			if (attempt < MAX_RETRIES) {
				console.log(`  本地上传失败（${error.message}），第${attempt}次重试...`);
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
			}
		}
	}

	return {
		filename,
		url: `file://${filePath}`,
		success: false,
		error: lastError?.message || '未知错误',
	};
}

async function uploadFromUrl(
	api: MediaWikiApi,
	fileConfig: FileConfig,
	globalConfig: UploadConfig,
	index: number,
	dryRun: boolean,
	article: string | undefined,
): Promise<UploadResult> {
	const filename = fileConfig.filename || generateFilename(fileConfig.url, article ?? '', index);
	const comment = globalConfig.comment || DEFAULT_COMMENT;
	const text = globalConfig.text || `{{Copyright}}[[Category:${article}]][[Category:迁移文件]]`;

	console.log(`  来源URL: ${fileConfig.url}`);

	if (dryRun) {
		console.log('  [试运行模式] 跳过实际上传');
		return {
			filename,
			url: fileConfig.url,
			success: true,
		};
	}

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await api.postWithToken('csrf', {
				action: 'upload',
				filename,
				url: fileConfig.url,
				comment,
				text,
				ignorewarnings: true,
				bot: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 500,
				noCache: true,
			});

			if (data.upload && data.upload.result === 'Success') {
				if (data.upload.warnings) {
					console.log('  警告: 文件已存在，已被覆盖');
				}
				return {
					filename,
					url: fileConfig.url,
					success: true,
				};
			} else {
				throw new Error(JSON.stringify(data));
			}
		} catch (error) {
			const errMessage = (error as Error).message;
			if (errMessage && errMessage.includes('moderation-image-queued')) {
				console.log('  文件已进入审核队列');
				return {
					filename,
					url: fileConfig.url,
					success: true,
				};
			}
			lastError = error as Error;
			if (attempt < MAX_RETRIES) {
				console.log(`  上传失败（${errMessage}），第${attempt}次重试...`);
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
			}
		}
	}

	const errorMessage = lastError?.message || '';
	if (errorMessage.includes('http-bad-status')) {
		console.log('  URL上传失败，尝试本地下载后上传...');
		ensureTempDir();
		const sanitizedFilename = filename.replace(/[<>:"/\\|?*]/g, '_');
		const tempFilePath = resolve(TEMP_DIR, `${Date.now()}_${sanitizedFilename.replace(/^File:/i, '')}`);

		try {
			const mimeType = await downloadImage(fileConfig.url, tempFilePath);
			const uploadResult = await uploadFromFile(api, tempFilePath, filename, comment, text, mimeType, dryRun);
			return uploadResult;
		} catch (downloadError: any) {
			console.log(`  本地下载上传失败: ${downloadError.message}`);
			return {
				filename,
				url: fileConfig.url,
				success: false,
				error: `URL上传失败且备用渠道失败: ${errorMessage}; 备用渠道: ${downloadError.message}`,
			};
		} finally {
			cleanupTempFile(tempFilePath);
		}
	}

	return {
		filename,
		url: fileConfig.url,
		success: false,
		error: errorMessage || '未知错误',
	};
}

async function batchUpload(
	api: MediaWikiApi,
	uploadConfig: UploadConfig,
	dryRun: boolean,
): Promise<UploadResult[]> {
	const results: UploadResult[] = [];
	const total = uploadConfig.files.length;

	for (let i = 0; i < total; i++) {
		const fileConfig = uploadConfig.files[i];
		const index = i + 1;

		console.log(`\n[${index}/${total}] 正在上传: ${fileConfig.filename || '(自动生成)'}`);

		const result = await uploadFromUrl(api, fileConfig, uploadConfig, index, dryRun, uploadConfig.article);
		results.push(result);

		if (result.success) {
			console.log('  上传成功！');
		} else {
			console.error(`  上传失败: ${result.error}`);
		}
	}

	return results;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		dryRun: false,
		verbose: false,
	};

	for (const arg of args) {
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--verbose') {
			result.verbose = true;
		}
	}

	return result;
}

async function main(): Promise<void> {
	console.log(`Start time: ${new Date().toISOString()}`);

	cleanupTempDir();

	const args = parseArgs(process.argv.slice(2));

	console.log('正在登录zh站...');
	await clientlogin(zhApi, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!)
		.then((result) => { console.log('zh站登录成功', result); });

	console.log('正在登录commons站...');
	await clientlogin(cmApi, config.cm.bot.clientUsername!, config.cm.bot.clientPassword!, config.cm.api)
		.then((result) => { console.log('commons站登录成功', result); });

	console.log(`\n正在读取配置文件: ${CONFIG_PAGE}`);
	let uploadConfig: UploadConfig;
	try {
		uploadConfig = await fetchJsonConfig(zhApi, CONFIG_PAGE);
	} catch (error) {
		console.error(`读取配置失败: ${(error as Error).message}`);
		process.exit(1);
	}

	console.log('正在验证配置...');
	const validation = validateConfig(uploadConfig);
	if (!validation.valid) {
		console.error('配置验证失败:');
		validation.errors.forEach(err => console.error(`  - ${err}`));
		process.exit(1);
	}

	console.log(`配置文件解析成功，共 ${uploadConfig.files.length} 个文件待上传`);

	if (args.dryRun) {
		console.log('\n[试运行模式] 不会实际上传文件');
	}

	const results = await batchUpload(cmApi, uploadConfig, args.dryRun);

	const successCount = results.filter(r => r.success).length;
	const failCount = results.filter(r => !r.success).length;

	console.log('\n上传完成！');
	console.log(`成功: ${successCount} 个`);
	console.log(`失败: ${failCount} 个`);

	if (failCount > 0 && args.verbose) {
		console.log('\n失败详情:');
		results.filter(r => !r.success).forEach(r => {
			console.log(`  - ${r.filename}: ${r.error}`);
		});
	}

	console.log(`\nEnd time: ${new Date().toISOString()}`);
}

main().catch((error: unknown) => {
	console.error('发生错误:', error);
	process.exit(1);
});
