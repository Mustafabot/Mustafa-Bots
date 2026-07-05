import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { URL } from 'url';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createZhApi, createCmApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { withApiRetry, checkModerationQueued, checkModerationQueuedError, isAbuseFilterError } from '../utils/retry.js';
import templateImageConfig from '../../config/templateImageConfig.json' with { type: 'json' };
import { buildTemplateNameMap, fetchRedirectsForTemplate } from '../utils/templateRedirects.js';

Parser.config = 'moegirl';

const MAX_API_RETRIES = 5;
const API_RETRY_DELAY = 3000;

async function withRetry<T>(
	fn: () => Promise<T>,
	options?: { maxRetries?: number; delay?: number }
): Promise<T> {
	const { maxRetries = MAX_API_RETRIES, delay = API_RETRY_DELAY } = options ?? {};
	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			const isNetworkError = lastError.message.includes('ECONNRESET') ||
				lastError.message.includes('BODY_TRANSFORM_ERROR') ||
				lastError.message.includes('NETWORK_ERROR') ||
				lastError.message.includes('terminated');
			if (isNetworkError && attempt < maxRetries) {
				console.error(`  网络错误 (尝试 ${attempt}/${maxRetries}): ${lastError.message}`);
				console.log(`  等待 ${delay}ms 后重试...`);
				await new Promise(resolve => setTimeout(resolve, delay));
			} else {
				throw lastError;
			}
		}
	}
	throw lastError;
}

interface ImageIssue {
	src: string;
	node: Parser.ExtToken;
	attributes: Record<string, string>;
}

interface TemplateImageIssue {
	src: string;
	templateNode: Parser.TranscludeToken;
	externalImageParam: string;
	internalImageParam: string;
	articleName?: string;
}

interface UploadResult {
	filename: string;
	url: string;
	success: boolean;
	error?: string;
	warnings?: any;
	skipReplace?: boolean;
	existingFile?: string;
	action?: string;
	isDryRun?: boolean;
}

interface PageProcessResult {
	title: string;
	imagesFound: number;
	imagesUploaded: number;
	imagesReplaced: number;
	uploadResults: UploadResult[];
	editError?: string;
	pendingFiles?: Array<[string, string]>;
}

interface WarningDecision {
	action: 'skip' | 'replace' | 'rename' | 'ignore' | 'fix-extension';
	reason: string;
	existingFile?: string;
	detectedMime?: string;
}

interface PageInfo {
	title: string;
	content: string;
}

interface ProcessStats {
	totalPages: number;
	totalFound: number;
	totalUploaded: number;
	totalReplaced: number;
	failedUploads: UploadResult[];
}

interface CliArgs {
	dryRun: boolean;
	verbose: boolean;
	namespace: string;
	reset: boolean;
	disableSongboxLookup: boolean;
}

const zhApi = createZhApi();
const cmApi = createCmApi();

const MAX_RETRIES = 3;
const MAX_RENAME_ATTEMPTS = 10;
const FORCE_UPLOAD_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：自其他网站迁移文件';
const SONGBOX_TEMPLATE = 'Template:VOCALOID Songbox';

// Cache for Songbox image lookups: article title → local filename (or null if no image)
const songboxImageCache = new Map<string, string | null>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHECKPOINT_DIR = resolve(__dirname, '../../data/checkpoint');
const CHECKPOINT_FILE = (namespace: string) => resolve(CHECKPOINT_DIR, `external_image_migrate_${namespace}.json`);
const PENDING_FILE = (namespace: string) => resolve(CHECKPOINT_DIR, `external_image_migrate_${namespace}_pending.json`);
const TEMP_DIR = resolve(__dirname, '../../temp');

interface CheckpointData {
	namespace: string;
	apcontinue: string;
	lastUpdate: string;
}

interface PendingEditFailure {
	title: string;
	error: string;
	files: Array<[string, string]>;
}

function savePendingFailures(namespace: string, failures: PendingEditFailure[]): void {
	try {
		if (failures.length === 0) return;
		if (!existsSync(CHECKPOINT_DIR)) {
			mkdirSync(CHECKPOINT_DIR, { recursive: true });
		}
		writeFileSync(PENDING_FILE(namespace), JSON.stringify(failures, null, 2), 'utf-8');
		console.log(`  已保存 ${failures.length} 个编辑失败的待处理记录到: ${PENDING_FILE(namespace)}`);
	} catch (error) {
		console.error('  保存待处理失败记录失败:', error);
	}
}

function saveCheckpoint(namespace: string, apcontinue: string): void {
	try {
		if (!existsSync(CHECKPOINT_DIR)) {
			mkdirSync(CHECKPOINT_DIR, { recursive: true });
		}
		const data: CheckpointData = {
			namespace,
			apcontinue,
			lastUpdate: new Date().toISOString(),
		};
		writeFileSync(CHECKPOINT_FILE(namespace), JSON.stringify(data, null, 2), 'utf-8');
		console.log(`  断点已保存: ${apcontinue}`);
	} catch (error) {
		console.error('  保存断点失败:', error);
	}
}

function loadCheckpoint(namespace: string): string | null {
	try {
		const filePath = CHECKPOINT_FILE(namespace);
		if (existsSync(filePath)) {
			const data: CheckpointData = JSON.parse(readFileSync(filePath, 'utf-8'));
			if (data.namespace === namespace && data.apcontinue) {
				console.log(`  发现断点文件，将从 ${data.apcontinue} 继续`);
				console.log(`  断点时间: ${data.lastUpdate}`);
				return data.apcontinue;
			}
		}
	} catch (error) {
		console.error('  读取断点失败:', error);
	}
	return null;
}

function clearCheckpoint(namespace: string): void {
	try {
		const filePath = CHECKPOINT_FILE(namespace);
		if (existsSync(filePath)) {
			unlinkSync(filePath);
			console.log(`  已清除断点文件: ${filePath}`);
		}
	} catch (error) {
		console.error('  清除断点失败:', error);
	}
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
	article: string,
	mimeType: string,
	dryRun: boolean
): Promise<UploadResult> {
	if (dryRun) {
		console.log(`  [试运行] 将从本地上传: ${filename}`);
		return { filename, url: `file://${filePath}`, success: true, isDryRun: true };
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
				text: `{{Copyright}}[[Category:${article}]][[Category:迁移文件]]`,
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
					console.log(`  本地上传失败（${error.message}），第${attempt}次重试...`);
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

const MIME_TO_EXT: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'image/svg+xml': '.svg',
	'image/jp2': '.jp2',
	'image/jpx': '.jp2',
	'image/bmp': '.bmp',
	'image/x-icon': '.ico',
	'image/avif': '.avif',
	'image/heic': '.heic',
	'image/heif': '.heif',
	'image/tiff': '.tiff',
	'image/x-tiff': '.tiff',
	'application/pdf': '.pdf',
	'audio/mpeg': '.mp3',
	'audio/mp3': '.mp3',
	'audio/ogg': '.ogg',
	'audio/x-ogg': '.ogg',
	'audio/flac': '.flac',
	'audio/x-flac': '.flac',
	'audio/opus': '.opus',
	'audio/wav': '.wav',
	'audio/x-wav': '.wav',
	'audio/midi': '.mid',
	'audio/x-midi': '.mid',
	'video/ogg': '.ogv',
	'video/webm': '.webm',
	'audio/webm': '.webm',
	'video/mpeg': '.mpg',
	'video/mpg': '.mpg',
	'font/ttf': '.ttf',
	'font/otf': '.ttf',
	'application/x-font-ttf': '.ttf',
	'application/x-font-otf': '.ttf',
	'font/woff2': '.woff2',
	'application/font-woff2': '.woff2',
};

function escapeWikitextLink(s: string): string {
	return s.replace(/\]\]/g, '&#93;&#93;');
}

function changeFileExtension(filename: string, newExt: string): string {
	const match = filename.match(/^(File:.+)(\.[a-zA-Z0-9]+)$/);
	if (match) {
		return `${match[1]}${newExt}`;
	}
	return `${filename}${newExt}`;
}

async function detectMimeFromUrl(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, {
			method: 'HEAD',
			headers: {
				'User-Agent': config.userAgent,
			},
		});
		const contentType = response.headers.get('content-type');
		if (contentType) {
			return contentType.split(';')[0].trim().toLowerCase();
		}
	} catch {
		console.error('  从URL检测MIME类型失败');
	}
	return null;
}

async function fetchWhitelist(api: MediaWikiApi): Promise<RegExp[]> {
	const { data } = await withRetry(() => api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: 'MediaWiki:External_image_whitelist',
	}));

	const page = Object.values((data as any).query.pages)[0] as any;
	if (!page || !page.revisions) {
		console.error('Failed to get external image whitelist');
		return [];
	}

	const content: string = page.revisions[0].content;
	const regexes = content
		.split('\n')
		.filter(line => line.trim() && !line.trim().startsWith('#'))
		.map(line => {
			try {
				return new RegExp(line.trim());
			} catch {
				console.error(`Invalid regex in whitelist: ${line}`);
				return null;
			}
		})
		.filter(Boolean) as RegExp[];

	console.log(`Loaded ${regexes.length} whitelist regexes`);
	return regexes;
}

// MediaWiki legaltitlechars fallback，\\x80-\\xFF 在 JS 中需转为 \\u0080-\\uFFFF 以覆盖 CJK
const DEFAULT_LEGAL_TITLE_CHARS = ' %!"$&\'()*,\\-./0-9:;=?@A-Z\\\\^_`a-z~\\u0080-\\uFFFF';

async function fetchLegalTitleRegex(api: MediaWikiApi): Promise<RegExp> {
	const { data } = await withRetry(() => api.post({
		action: 'query',
		meta: 'siteinfo',
		siprop: 'general',
	}));

	const legaltitlechars: string = (data as any).query?.general?.legaltitlechars;
	const raw = legaltitlechars || DEFAULT_LEGAL_TITLE_CHARS;
	const jsSafe = raw.replace(/\\x80-\\xFF/, '\\u0080-\\uFFFF');

	try {
		return new RegExp(`[^${jsSafe}]`, 'gu');
	} catch {
		console.error('legaltitlechars 正则无效，使用默认规则');
		return new RegExp(`[^${DEFAULT_LEGAL_TITLE_CHARS}]`, 'gu');
	}
}

async function processPagesInBatches(
	api: MediaWikiApi,
	namespace: string,
	processBatch: (pages: PageInfo[]) => Promise<void>,
	initialApcontinue?: string | null
): Promise<void> {
	const eol = Symbol();
	let apcontinue: string | symbol | undefined = initialApcontinue ?? undefined;
	let batchIndex = 0;

	if (initialApcontinue) {
		console.log(`\n从断点继续: ${initialApcontinue}`);
	}

	while (apcontinue !== eol) {
		const titlesData = await withRetry(async () => {
			const { data } = await api.post({
				action: 'query',
				generator: 'allpages',
				gapnamespace: namespace,
				gaplimit: 500,
				gapcontinue: apcontinue as string | undefined,
			});
			return (data as any);
		});

		const nextApcontinue: string | symbol = titlesData.continue?.gapcontinue ?? eol;
		batchIndex++;
		console.log(`\n=== 批次 ${batchIndex} ===`);
		console.log(`gapcontinue: ${nextApcontinue === eol ? 'END_OF_LIST' : String(nextApcontinue)}`);

		const batchTitles: string[] = Object.values(titlesData.query.pages).map((page: any) => page.title);
		console.log(`本批次获取 ${batchTitles.length} 个页面标题`);

		const pages: PageInfo[] = [];
		const CONTENT_BATCH_SIZE = 25;

		for (let i = 0; i < batchTitles.length; i += CONTENT_BATCH_SIZE) {
			const contentBatch = batchTitles.slice(i, i + CONTENT_BATCH_SIZE);
			const contentData = await withRetry(async () => {
				const { data } = await api.post({
					action: 'query',
					prop: 'revisions',
					rvprop: 'content',
					titles: contentBatch.join('|'),
				});
				return (data as any);
			});

			const batchPages: PageInfo[] = Object.values(contentData.query.pages)
				.filter((page: any) => page.revisions?.length)
				.map((page: any) => ({
					title: page.title,
					content: page.revisions[0].content,
				}));

			pages.push(...batchPages);
		}

		console.log(`本批次有效页面数: ${pages.length}`);

		await processBatch(pages);

		if (nextApcontinue !== eol && typeof nextApcontinue === 'string') {
			saveCheckpoint(namespace, nextApcontinue);
		}

		apcontinue = nextApcontinue;
	}

	clearCheckpoint(namespace);
	console.log('\n处理完成，已清除断点文件');
}

function extractExtension(url: string): string {
	const commonImageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'jp2', 'bmp', 'ico', 'avif', 'heic', 'heif'];
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname;
		const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
		if (match && commonImageExts.includes(match[1].toLowerCase())) {
			return `.${match[1].toLowerCase()}`;
		}
		const queryMatch = urlObj.search.match(/[?&](?:file|img|image|src|url)=[^&]*\.([a-zA-Z0-9]+)/i);
		if (queryMatch && commonImageExts.includes(queryMatch[1].toLowerCase())) {
			return `.${queryMatch[1].toLowerCase()}`;
		}
		return '.png';
	} catch {
		return '.png';
	}
}

function sanitizeFilenameComponent(raw: string, legalTitleRe: RegExp): string {
	return raw.replace(legalTitleRe, '').replace(/\s+/g, ' ').trim();
}

function generateFilename(
	url: string,
	article: string,
	index: number,
	legalTitleRe: RegExp,
	titleAttr?: string,
): string {
	const ext = extractExtension(url);
	const safeArticle = sanitizeFilenameComponent(article.replace(/\//g, '-'), legalTitleRe);
	if (titleAttr) {
		const safeTitle = sanitizeFilenameComponent(titleAttr, legalTitleRe);
		if (safeTitle) {
			return `File:${safeArticle} ${safeTitle}${ext}`;
		}
	}
	if (index > 0) {
		return `File:${safeArticle} ${index}${ext}`;
	}
	return `File:${safeArticle}${ext}`;
}

function generateRenamedFilename(originalFilename: string, suffix: number): string {
	const match = originalFilename.match(/^(File:)(.+)(\.[a-zA-Z0-9]+)$/);
	if (match) {
		return `${match[1]}${match[2]} ${suffix}${match[3]}`;
	}
	return `${originalFilename} ${suffix}`;
}

function parseUploadWarnings(warnings: Record<string, any>): WarningDecision {
	const warningKeys = Object.keys(warnings);

	if (warningKeys.includes('filetype-mime')) {
		const mimeInfo = warnings['filetype-mime'];
		let detectedMime: string | undefined;
		if (Array.isArray(mimeInfo) && mimeInfo.length >= 2) {
			detectedMime = String(mimeInfo[1]).toLowerCase();
		} else if (typeof mimeInfo === 'string') {
			const mimeMatch = mimeInfo.match(/(image\/[a-z+-]+)/i);
			if (mimeMatch) {
				detectedMime = mimeMatch[1].toLowerCase();
			}
		}
		return {
			action: 'fix-extension',
			reason: `文件扩展名与MIME类型不匹配${detectedMime ? `，检测到MIME类型: ${detectedMime}` : ''}`,
			detectedMime,
		};
	}

	if (warningKeys.includes('was-deleted')) {
		return {
			action: 'skip',
			reason: '文件曾被删除，跳过上传和替换',
		};
	}

	if (warningKeys.includes('duplicate-archive')) {
		return {
			action: 'skip',
			reason: '文件曾存在但已删除，跳过上传和替换',
		};
	}

	if (warningKeys.includes('duplicate')) {
		const duplicateInfo = warnings.duplicate;
		let existingFile: string = duplicateInfo;
		if (Array.isArray(duplicateInfo) && duplicateInfo.length > 0) {
			existingFile = duplicateInfo[0];
		}
		if (typeof existingFile === 'string' && !existingFile.startsWith('File:')) {
			existingFile = `File:${existingFile}`;
		}
		return {
			action: 'replace',
			existingFile,
			reason: `文件已以其他名称存在: ${existingFile}，跳过上传直接替换`,
		};
	}

	if (warningKeys.includes('duplicateversions')) {
		const existsInfo = warnings.exists;
		let existingFile: string | undefined;
		if (existsInfo) {
			existingFile = existsInfo;
			if (Array.isArray(existsInfo) && existsInfo.length > 0) {
				existingFile = existsInfo[0];
			}
			if (typeof existingFile === 'string' && !existingFile.startsWith('File:')) {
				existingFile = `File:${existingFile}`;
			}
		}
		return {
			action: 'replace',
			existingFile,
			reason: '文件版本已存在（上传的是旧版本），跳过上传直接替换',
		};
	}

	if (warningKeys.includes('nochange')) {
		const existsInfo = warnings.exists;
		let existingFile: string | undefined;
		if (existsInfo) {
			existingFile = existsInfo;
			if (Array.isArray(existsInfo) && existsInfo.length > 0) {
				existingFile = existsInfo[0];
			}
			if (typeof existingFile === 'string' && !existingFile.startsWith('File:')) {
				existingFile = `File:${existingFile}`;
			}
		}
		return {
			action: 'replace',
			existingFile,
			reason: '文件内容相同，跳过上传直接替换',
		};
	}

	if (warningKeys.includes('exists')) {
		return {
			action: 'rename',
			reason: '文件已存在但内容不同，需要改名上传',
		};
	}

	return {
		action: 'ignore',
		reason: '其他警告，忽略并继续上传',
	};
}

function ensureUrlProtocol(url: string): string {
	if (url.startsWith('//')) return 'https:' + url;
	if (!/^https?:\/\//i.test(url)) return 'https://' + url;
	return url;
}

function isWhitelisted(src: string, whitelist: RegExp[]): boolean {
	if (whitelist.some(regex => regex.test(src))) {
		return true;
	}
	if (src.startsWith('//')) {
		return whitelist.some(regex => regex.test('https:' + src));
	}
	if (src.startsWith('http://')) {
		const httpsUrl = src.replace('http://', 'https://');
		if (whitelist.some(regex => regex.test(httpsUrl))) {
			return true;
		}
	}
	return false;
}

function extractExternalImages(content: string, title: string, whitelist: RegExp[]): { parsed: Parser.Token; issues: ImageIssue[] } {
	const issues: ImageIssue[] = [];
	const parsed = Parser.parse(content, title);

	function traverse(node: Parser.AstNodes): void {
		if ('type' in node && node.type !== 'text' && node.is<Parser.ExtToken>('ext') && node.name === 'img') {
			const src = node.attributes?.src;
			if (typeof src === 'string') {
				const normalizedSrc = ensureUrlProtocol(src);
				if (!isWhitelisted(src, whitelist)) {
					issues.push({
						src: normalizedSrc,
						node,
						attributes: node.getAttrs() as Record<string, string>,
					});
				}
			}
		}

		if ('children' in node) {
			for (const child of node.children) {
				traverse(child);
			}
		}
	}

	traverse(parsed);
	return { parsed, issues };
}

function extractLinkTarget(wikitext: string): string | null {
	const resolved = wikitext.replace(/\{\{!\}\}/g, '|');
	const parsed = Parser.parse(resolved, false, 7);
	const links = parsed.querySelectorAll<Parser.LinkToken>('link');
	if (links.length > 0) {
		const linkTarget: string | { title?: string } = links[0].link;
		const targetStr = typeof linkTarget === 'string' ? linkTarget : String(linkTarget);
		const cleaned = targetStr.split('#')[0].trim();
		if (cleaned) {
			return cleaned;
		}
	}
	const pipeIndex = resolved.indexOf('|');
	if (pipeIndex > 0) {
		const beforePipe = resolved.substring(0, pipeIndex).trim();
		if (beforePipe) {
			return beforePipe;
		}
	}
	return null;
}

function extractTemplateImageParams(
	parsed: Parser.Token,
	whitelist: RegExp[],
	templateNameMap: Map<string, typeof templateImageConfig[number]>,
): { issues: TemplateImageIssue[]; filepathResolved: number } {
	const issues: TemplateImageIssue[] = [];
	let filepathResolved = 0;
	const allTemplateNodes = parsed.querySelectorAll<Parser.TranscludeToken>('template');
	for (const templateNode of allTemplateNodes) {
		const name: string | undefined = templateNode.name;
		const normalizedName = name?.replace(/_/g, ' ');
		const templateConfig = normalizedName ? templateNameMap.get(normalizedName) : undefined;
		if (!templateConfig) continue;

		const existingInternal = templateNode.getValue?.(templateConfig.internalImageParam);
		if (existingInternal && existingInternal.trim()) continue;

		const imageValue = templateNode.getValue?.(templateConfig.externalImageParam);
		let src: string | undefined;

		if (imageValue && imageValue.trim() && !isWhitelisted(imageValue.trim(), whitelist)) {
				// {{filepath:...}} 表示内部图片引用，直接在提取阶段规范化
				const fpMatch = imageValue.trim().match(/^\{\{filepath\s*:\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}$/i);
				if (fpMatch) {
					templateNode.removeArg(templateConfig.externalImageParam);
					templateNode.setValue(templateConfig.internalImageParam, fpMatch[1].trim());
					filepathResolved++;
					continue;
				}
			src = ensureUrlProtocol(imageValue.trim());
		} else if (!imageValue?.trim() && (templateConfig as any).fallback) {
			const fb = (templateConfig as any).fallback;
			const fbValues: Record<string, string> = {};
			let allPresent = true;
			for (const p of fb.params as string[]) {
				const val = templateNode.getValue?.(p);
				if (!val || !val.trim()) {
					allPresent = false;
					break;
				}
				fbValues[p] = val.trim();
			}
			if (allPresent) {
				let fallbackUrl: string = fb.urlTemplate;
				for (const [key, val] of Object.entries(fbValues)) {
					fallbackUrl = fallbackUrl.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
				}
				src = ensureUrlProtocol(fallbackUrl);
			}
		}

		if (src) {
			let articleName: string | undefined;
			for (const param of templateConfig.articleParams) {
				const val = templateNode.getValue?.(param);
				if (val && val.trim()) {
					const rawValue = val.trim();
					const linkTarget = extractLinkTarget(rawValue);
					articleName = linkTarget ?? rawValue;
					break;
				}
			}
			issues.push({
				src,
				templateNode,
				externalImageParam: templateConfig.externalImageParam,
				internalImageParam: templateConfig.internalImageParam,
				articleName,
			});
		}
	}
	return { issues, filepathResolved };
}

interface MimeMismatchError {
	isMimeMismatch: boolean;
	detectedMime?: string;
}

function parseMimeMismatchError(error: any): MimeMismatchError {
	try {
		const errorObj = JSON.parse(error.message);
		const errors = errorObj?.errors;
		if (Array.isArray(errors)) {
			for (const err of errors) {
				if (err.code === 'verification-error' && err.data?.details?.[0] === 'filetype-mime-mismatch') {
					const detectedMime = err.data.details[2];
					if (typeof detectedMime === 'string') {
						return { isMimeMismatch: true, detectedMime: detectedMime.toLowerCase() };
					}
				}
			}
		}
	} catch {
		console.error('  解析MIME不匹配错误失败');
	}
	return { isMimeMismatch: false };
}

async function forceUploadWithRetry(
	api: MediaWikiApi,
	url: string,
	filename: string,
	comment: string,
	article: string,
	warnings: any
): Promise<UploadResult> {
	console.log('  忽略警告，强制上传...');

	try {
		return await withApiRetry(
			() => api.postWithToken('csrf', {
				action: 'upload',
				filename,
				url,
				comment,
				text: `{{Copyright}}[[Category:${article}]][[Category:迁移文件]]`,
				ignorewarnings: true,
				bot: true,
				tags: 'Bot',
				watchlist: 'nochange',
			}, {
				retry: 500,
				noCache: true,
			}),
			{
				maxRetries: FORCE_UPLOAD_RETRIES,
				baseDelay: 1000,
				onSuccess: (forceData) => {
					if (forceData.upload && forceData.upload.result === 'Success') {
						console.log('  强制上传成功');
						return { filename, url, success: true, warnings, action: 'ignore' };
					}

					if (checkModerationQueued(forceData, '  文件已进入审核队列')) {
						return { filename, url, success: true, warnings, action: 'ignore' };
					}

					console.log(`  强制上传失败: ${JSON.stringify(forceData)}`);
					throw new Error(`强制上传失败: ${JSON.stringify(forceData)}`);
				},
				onError: (error, attempt) => {
					if (checkModerationQueuedError(error, '  文件已进入审核队列')) {
						throw error;
					}
					console.log(`  强制上传第${attempt}次重试...`);
				},
				shouldRetry: () => true
			}
		);
	} catch (error: any) {
		return {
			filename,
			url,
			success: false,
			warnings,
			error: `强制上传失败: ${error?.message || '未知错误'}`,
		};
	}
}

async function uploadFromUrl(
	api: MediaWikiApi,
	url: string,
	filename: string,
	comment: string,
	dryRun: boolean,
	article: string
): Promise<UploadResult> {
	if (dryRun) {
		console.log(`  [试运行] 将上传: ${filename}`);
		return { filename, url, success: true, isDryRun: true };
	}

	let currentFilename = filename;
	let renameSuffix = 1;
	let renameAttempts = 0;
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await api.postWithToken('csrf', {
				action: 'upload',
				filename: currentFilename,
				url,
				comment,
				text: `{{Copyright}}[[Category:${article}]][[Category:迁移文件]]`,
				ignorewarnings: false,
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
				return { filename: currentFilename, url, success: true };
			}

			if (data.upload && data.upload.result === 'Warning' && data.upload.warnings) {
				const warnings = data.upload.warnings;
				const decision = parseUploadWarnings(warnings);

				console.log(`  收到警告: ${Object.keys(warnings).join(', ')}`);
				console.log(`  处理策略: ${decision.reason}`);

				if (decision.action === 'skip') {
					return {
						filename: currentFilename,
						url,
						success: false,
						warnings,
						skipReplace: true,
						action: decision.action,
						error: decision.reason,
					};
				}

				if (decision.action === 'replace') {
					const useFilename = decision.existingFile || currentFilename;
					console.log(`  跳过上传，将使用文件: ${useFilename}`);
					return {
						filename: useFilename,
						url,
						success: true,
						warnings,
						existingFile: decision.existingFile,
						action: decision.action,
					};
				}

				if (decision.action === 'rename') {
					renameAttempts++;
					if (renameAttempts > MAX_RENAME_ATTEMPTS) {
						console.log(`  改名次数超限（${MAX_RENAME_ATTEMPTS}次），跳过此文件`);
						return {
							filename: currentFilename,
							url,
							success: false,
							warnings,
							skipReplace: true,
							action: decision.action,
							error: '改名次数超限',
						};
					}
					renameSuffix++;
					currentFilename = generateRenamedFilename(filename, renameSuffix);
					console.log(`  改名重试: ${currentFilename}`);
					attempt--;
					continue;
				}

				if (decision.action === 'fix-extension') {
					let detectedMime = decision.detectedMime;
					if (!detectedMime) {
						console.log('  警告中未包含MIME类型，尝试从URL检测...');
						detectedMime = (await detectMimeFromUrl(url)) || undefined;
					}
					if (detectedMime && MIME_TO_EXT[detectedMime]) {
						const newExt = MIME_TO_EXT[detectedMime];
						const newFilename = changeFileExtension(currentFilename, newExt);
						if (newFilename !== currentFilename) {
							console.log(`  修正扩展名: ${currentFilename} -> ${newFilename} (MIME: ${detectedMime})`);
							currentFilename = newFilename;
							attempt--;
							continue;
						}
						console.log(`  扩展名已与MIME类型匹配(${newExt})，尝试强制上传...`);
					} else {
						console.log(`  无法确定正确的扩展名${detectedMime ? ` (MIME: ${detectedMime})` : ''}，尝试强制上传...`);
					}
					return await forceUploadWithRetry(api, url, currentFilename, comment, article, warnings);
				}

				if (decision.action === 'ignore') {
					return await forceUploadWithRetry(api, url, currentFilename, comment, article, warnings);
				}
			}

			throw new Error(JSON.stringify(data));
		} catch (error: any) {
			if (checkModerationQueuedError(error, '  文件已进入审核队列')) {
				return { filename: currentFilename, url, success: true };
			}
			const mimeMismatch = parseMimeMismatchError(error);
			if (mimeMismatch.isMimeMismatch && mimeMismatch.detectedMime && MIME_TO_EXT[mimeMismatch.detectedMime]) {
				const newExt = MIME_TO_EXT[mimeMismatch.detectedMime];
				const newFilename = changeFileExtension(currentFilename, newExt);
				if (newFilename !== currentFilename) {
					console.log(`  扩展名与MIME不匹配，修正: ${currentFilename} -> ${newFilename} (MIME: ${mimeMismatch.detectedMime})`);
					currentFilename = newFilename;
					attempt--;
					continue;
				}
			}
			lastError = error;
			if (attempt < MAX_RETRIES) {
				if (isAbuseFilterError(error)) {
					console.log(`  遇到滥用过滤器警告，第${attempt}次重试...`);
				} else {
					console.log(`  上传失败（${error.message}），第${attempt}次重试...`);
				}
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
				continue;
			}
		}
	}

	const errorMessage = lastError?.message || '';
	if (errorMessage.includes('http-bad-status')) {
		console.log('  URL上传失败，尝试本地下载后上传...');
		ensureTempDir();
		const sanitizedFilename = currentFilename.replace(/[<>:"/\\|?*]/g, '_');
		const tempFilePath = resolve(TEMP_DIR, `${Date.now()}_${sanitizedFilename.replace(/^File:/i, '')}`);

		try {
			const mimeType = await downloadImage(url, tempFilePath);
			const uploadResult = await uploadFromFile(api, tempFilePath, currentFilename, comment, article, mimeType, dryRun);
			return uploadResult;
		} catch (downloadError: any) {
			console.log(`  本地下载上传失败: ${downloadError.message}`);
			return {
				filename: currentFilename,
				url,
				success: false,
				error: `URL上传失败且备用渠道失败: ${errorMessage}; 备用渠道: ${downloadError.message}`,
			};
		} finally {
			cleanupTempFile(tempFilePath);
		}
	}

	return {
		filename: currentFilename,
		url,
		success: false,
		error: errorMessage || '未知错误',
	};
}

function canMapStyleToWiki(style: string): boolean {
	if (!style) return true;
	const mappableProps = ['float', 'vertical-align', 'width', 'height'];
	const props = style.split(';').map(s => s.trim()).filter(Boolean);
	for (const prop of props) {
		const [name] = prop.split(':').map(s => s.trim().toLowerCase());
		if (name && !mappableProps.includes(name)) {
			return false;
		}
	}
	return true;
}

function extractSizeFromStyle(style: string): { width?: number; height?: number } {
	const result: { width?: number; height?: number } = {};
	if (!style) return result;
	const widthMatch = style.match(/width\s*:\s*(\d+)(?:px)?(?=\s|;|$)/i);
	if (widthMatch) {
		result.width = parseInt(widthMatch[1], 10);
	}
	const heightMatch = style.match(/height\s*:\s*(\d+)(?:px)?(?=\s|;|$)/i);
	if (heightMatch) {
		result.height = parseInt(heightMatch[1], 10);
	}
	return result;
}

/**
 * wikiparser-node 的 `getAttribute` 是内部 API，此函数封装类型转换以避免散落的 `as any`。
 */
function getInternalParserAttributes(refNode: Parser.Token): { config: Parser.Config; include: boolean } {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const node = refNode as any;
	return { config: node.getAttribute('config'), include: node.getAttribute('include') };
}

function buildImgParserFunction(filename: string, attributes: Record<string, string>, refNode: Parser.Token): Parser.Token {
	const imgName = filename.replace(/^File:/i, '');
	let wikitext = `{{#img:{{filepath:${imgName}}}`;
	for (const [key, value] of Object.entries(attributes)) {
		if (key !== 'src') {
			wikitext += `|${key}=${value}`;
		}
	}

	wikitext += '}}';

	const { config: nodeConfig, include } = getInternalParserAttributes(refNode);
	const root = Parser.parse(wikitext, include, 7, nodeConfig);
	return root.children[0] as Parser.Token;
}

function buildInternalFileLink(filename: string, attributes: Record<string, string>, refNode: Parser.Token): Parser.Token {
	if (!canMapStyleToWiki(attributes.style)) {
		return buildImgParserFunction(filename, attributes, refNode);
	}

	const imgName = filename.replace(/^File:/i, '');
	const options: string[] = [];
	let caption = '';

	if (attributes.style) {
		const style = attributes.style;
		if (/\bfloat\s*:\s*left\b/i.test(style)) {
			options.push('left');
		} else if (/\bfloat\s*:\s*right\b/i.test(style)) {
			options.push('right');
		}
		const vAlignMatch = style.match(/vertical-align\s*:\s*(baseline|sub|super|top|text-top|middle|text-bottom|bottom)/i);
		if (vAlignMatch) {
			options.push(vAlignMatch[1].toLowerCase());
		}
	}

	const attrWidth = parseInt(attributes.width, 10);
	const attrHeight = parseInt(attributes.height, 10);
	const styleSize = extractSizeFromStyle(attributes.style);
	const widthVal = attrWidth || styleSize.width;
	const heightVal = attrHeight || styleSize.height;
	if (widthVal && heightVal) {
		options.push(`${widthVal}x${heightVal}px`);
	} else if (widthVal) {
		options.push(`${widthVal}px`);
	} else if (heightVal) {
		options.push(`x${heightVal}px`);
	}

	if (attributes.alt) {
		options.push(`alt=${escapeWikitextLink(attributes.alt)}`);
	}

	if (attributes['class']) {
		options.push(`class=${escapeWikitextLink(attributes['class'])}`);
	}

	if (attributes.link) {
		options.push(`link=${escapeWikitextLink(attributes.link)}`);
	}

	if (attributes.title) {
		caption = escapeWikitextLink(attributes.title);
	}

	const parts = ['File:' + imgName, ...options];
	if (caption) {
		parts.push(caption);
	}

	const wikitext = `[[${parts.join('|')}]]`;

	const { config: nodeConfig, include } = getInternalParserAttributes(refNode);
	const root = Parser.parse(wikitext, include, 7, nodeConfig);
	const parserNode = root.children[0] as Parser.Token;

	return parserNode;
}

function replaceImageNodes(parsed: Parser.Token, issues: ImageIssue[], urlToFilename: Map<string, string>): string {
	for (const issue of issues) {
		const filename = urlToFilename.get(issue.src);
		if (!filename) continue;

		const fileNode = buildInternalFileLink(filename, issue.attributes, parsed);
		issue.node.replaceWith(fileNode);
	}

	return parsed.toString();
}

function replaceTemplateImageParams(
	templateIssues: TemplateImageIssue[],
	urlToFilename: Map<string, string>,
): void {
	for (const issue of templateIssues) {
		const filename = urlToFilename.get(issue.src);
		if (!filename) continue;
		const bareName = filename.replace(/^File:/i, '');
		issue.templateNode.removeArg(issue.externalImageParam);
		issue.templateNode.setValue(issue.internalImageParam, bareName);
	}
}

async function editPage(api: MediaWikiApi, title: string, content: string, summary: string, dryRun: boolean): Promise<void> {
	if (dryRun) {
		console.log(`  [试运行] 将编辑页面: ${title}`);
		return;
	}

	await withApiRetry(
		() => api.postWithToken('csrf', {
			action: 'edit',
			title,
			text: content,
			summary,
			bot: true,
			notminor: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 500,
			noCache: true,
		}),
		{
			maxRetries: MAX_RETRIES,
			baseDelay: 1000,
			onSuccess: () => {
				return undefined;
			},
			onError: (error, attempt) => {
				if (isAbuseFilterError(error)) {
					console.log(`  编辑遇到滥用过滤器警告，第${attempt}次重试...`);
				} else {
					console.log(`  编辑失败（${error.message}），第${attempt}次重试...`);
				}
			},
			shouldRetry: () => true
		}
	);
}

function extractLocalFileFromSongboxImage(rawValue: string): string | null {
	const trimmed = rawValue.trim();
	if (!trimmed) return null;

	// Skip external URLs — can't use as local file reference
	if (/^https?:\/\//i.test(trimmed)) return null;

	// Handle [[File:name|...]] or [[File:name]] format
	const fileLinkMatch = trimmed.match(/^\[\[File:([^|\]]+)/i);
	if (fileLinkMatch) return fileLinkMatch[1].trim();

	// Handle "File:" prefix
	const filePrefixMatch = trimmed.match(/^File:(.+)/i);
	if (filePrefixMatch) return filePrefixMatch[1].trim();

	// Plain filename
	return trimmed;
}

async function fetchSongboxRedirects(api: MediaWikiApi): Promise<Set<string>> {
	const redirects = await fetchRedirectsForTemplate(api, SONGBOX_TEMPLATE);
	const canonicalName = SONGBOX_TEMPLATE.replace(/^Template:/i, '');
	const names = new Set<string>([canonicalName]);
	for (const r of redirects) {
		names.add(r.replace(/^Template:/i, ''));
	}
	return names;
}

/**
 * 批量查询多个条目的 Songbox 配图，使用单次 titles= 查询。
 * 结果写入 songboxImageCache，未找到的条目缓存为 null。
 */
async function fetchSongboxImages(
	api: MediaWikiApi,
	articleNames: Iterable<string>,
	songboxNames: Set<string>,
): Promise<void> {
	const uncached: string[] = [];
	for (const name of articleNames) {
		if (!songboxImageCache.has(name)) {
			uncached.push(name);
		}
	}
	if (uncached.length === 0) return;

	const { data } = await withRetry(() => api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: uncached.join('|'),
	}));

	const pages = Object.values((data as any).query.pages) as any[];
	for (const page of pages) {
		const title = page.title as string;
		if (!page?.revisions?.[0]?.content) {
			songboxImageCache.set(title, null);
			continue;
		}

		const content: string = page.revisions[0].content;
		const parsed = Parser.parse(content, title);
		const templates = parsed.querySelectorAll<Parser.TranscludeToken>('template');

		let found = false;
		for (const tmpl of templates) {
			const name = tmpl.name?.replace(/_/g, ' ').replace(/^template:/i, '');
			if (!name || !songboxNames.has(name)) continue;

			const imageValue = tmpl.getValue?.('image');
			if (imageValue) {
				const localFile = extractLocalFileFromSongboxImage(imageValue);
				if (localFile) {
					songboxImageCache.set(title, localFile);
					found = true;
					break;
				}
			}
		}
		if (!found) {
			songboxImageCache.set(title, null);
		}
	}
}

async function processPage(
	uploadApi: MediaWikiApi,
	editApi: MediaWikiApi,
	page: PageInfo,
	whitelist: RegExp[],
	dryRun: boolean,
	templateNameMap: Map<string, typeof templateImageConfig[number]>,
	legalTitleRe: RegExp,
	songboxNames: Set<string>,
): Promise<PageProcessResult> {
	const { title, content } = page;
	const result: PageProcessResult = {
		title,
		imagesFound: 0,
		imagesUploaded: 0,
		imagesReplaced: 0,
		uploadResults: [],
	};

	console.log(`处理页面: ${title}`);

	const { parsed, issues } = extractExternalImages(content, title, whitelist);
	const extracted = extractTemplateImageParams(parsed, whitelist, templateNameMap);
	let { issues: templateIssues } = extracted;
	const { filepathResolved: filepathResolvedCount } = extracted;
	result.imagesFound = issues.length + templateIssues.length + filepathResolvedCount;

	if (issues.length === 0 && templateIssues.length === 0) {
		console.log('  无外部图片需要处理');
		return result;
	}

	if (filepathResolvedCount > 0) {
		console.log(`  filepath内部图片${filepathResolvedCount}个已直接替换`);
	}

	console.log(`  发现 ${issues.length} 个外部图片标签、${templateIssues.length} 个模板外部图片参数`);

	let songboxResolvedCount = 0;

	// Songbox 预查：直接套用对应条目的 VOCALOID Songbox 配图
	if (songboxNames.size > 0 && templateIssues.length > 0) {
		const uniqueArticles = new Set(
			templateIssues
				.filter(i => i.articleName)
				.map(i => i.articleName!.trim()),
		);
		if (uniqueArticles.size > 0) {
			console.log(`  检查 ${uniqueArticles.size} 个关联条目 Songbox 配图...`);
			await fetchSongboxImages(editApi, uniqueArticles, songboxNames);
			const resolved = new Set<TemplateImageIssue>();
			for (const articleName of uniqueArticles) {
				const localFile = songboxImageCache.get(articleName) ?? null;
				if (!localFile) continue;
				const bareName = localFile.replace(/^File:/i, '');
				let applied = 0;
				for (const issue of templateIssues) {
					if (issue.articleName?.trim() === articleName) {
						issue.templateNode.removeArg(issue.externalImageParam);
						issue.templateNode.setValue(issue.internalImageParam, bareName);
						resolved.add(issue);
						applied++;
					}
				}
				console.log(`    条目「${articleName}」→ File:${bareName} (套用 ${applied} 处)`);
			}
			songboxResolvedCount += resolved.size;
			templateIssues = templateIssues.filter(i => !resolved.has(i));
		}
	}

	const srcToNodes = new Map<string, ImageIssue[]>();
	for (const issue of issues) {
		if (!srcToNodes.has(issue.src)) {
			srcToNodes.set(issue.src, []);
		}
		srcToNodes.get(issue.src)!.push(issue);
	}

	const srcToTemplateNodes = new Map<string, TemplateImageIssue[]>();
	const srcToArticleName = new Map<string, string>();
	for (const issue of templateIssues) {
		if (!srcToTemplateNodes.has(issue.src)) {
			srcToTemplateNodes.set(issue.src, []);
		}
		srcToTemplateNodes.get(issue.src)!.push(issue);
		if (issue.articleName && !srcToArticleName.has(issue.src)) {
			srcToArticleName.set(issue.src, issue.articleName);
		}
	}

	const uniqueSrcs = [...new Set([...srcToNodes.keys(), ...srcToTemplateNodes.keys()])];
	console.log(`  去重后需上传 ${uniqueSrcs.length} 张图片`);

	const urlToFilename = new Map<string, string>();
	const usedFilenames = new Set<string>();

	for (let i = 0; i < uniqueSrcs.length; i++) {
		const src = uniqueSrcs[i];
		const index = i + 1;
		const nodes = srcToNodes.get(src);
		const isTemplateOnly = !nodes && srcToTemplateNodes.has(src);
		const titleAttr = nodes?.[0]?.attributes.title;
		const effectiveArticle = srcToArticleName.get(src) ?? title;
		let filename = generateFilename(src, effectiveArticle, isTemplateOnly ? 0 : index, legalTitleRe, titleAttr);

		if (usedFilenames.has(filename)) {
			let suffix = 2;
			while (usedFilenames.has(generateRenamedFilename(filename, suffix))) {
				suffix++;
			}
			filename = generateRenamedFilename(filename, suffix);
		}
		usedFilenames.add(filename);

		const imgRefCount = nodes?.length ?? 0;
		const templateRefCount = srcToTemplateNodes.get(src)?.length ?? 0;
		const totalRefs = imgRefCount + templateRefCount;

		console.log(`  [${index}/${uniqueSrcs.length}] 上传: ${filename}`);
		console.log(`    来源: ${src}`);
		console.log(`    页面内引用次数: ${totalRefs}`);

		const uploadResult = await uploadFromUrl(
			uploadApi,
			src,
			filename,
			DEFAULT_COMMENT,
			dryRun,
			title
		);

		result.uploadResults.push(uploadResult);

		if (uploadResult.skipReplace) {
			console.log(`    跳过替换: ${uploadResult.error}`);
		} else if (uploadResult.success) {
			result.imagesUploaded++;
			const useFilename = uploadResult.existingFile || uploadResult.filename;
			urlToFilename.set(src, useFilename);
			if (uploadResult.action === 'replace') {
				console.log(`    使用已存在文件: ${useFilename}`);
			} else {
				console.log(`    上传成功: ${useFilename}`);
			}
		} else {
			console.log(`    上传失败: ${uploadResult.error}`);
		}
	}

	const preResolvedCount = songboxResolvedCount + filepathResolvedCount;
	if (urlToFilename.size > 0 || preResolvedCount > 0) {
		const totalReplacements = issues.length + templateIssues.length + preResolvedCount;
		console.log(`  替换页面中的 ${totalReplacements} 个图片引用...`);
		replaceTemplateImageParams(templateIssues, urlToFilename);
		const newContent = replaceImageNodes(parsed, issues, urlToFilename);

		try {
			const catParts: string[] = [];
			if (issues.length > 0) catParts.push(`<img/>${issues.length}个`);
			if (templateIssues.length > 0) catParts.push(`模板外链图片参数${templateIssues.length}个`);
			if (songboxResolvedCount > 0) catParts.push(`套用既有条目[[T:VOCALOID Songbox]]头图${songboxResolvedCount}个`);
			if (filepathResolvedCount > 0) catParts.push(`filepath内部图片${filepathResolvedCount}个`);
			const summary = DEFAULT_COMMENT + '（' + catParts.join('，') + `，共${totalReplacements}个）`;
			await editPage(editApi, title, newContent, summary, dryRun);
			result.imagesReplaced = totalReplacements;
			console.log('  页面编辑成功');
		} catch (error: any) {
			console.error(`  页面编辑失败: ${error.message}`);
			result.editError = error.message;
			result.pendingFiles = [...urlToFilename.entries()];
			result.imagesReplaced = preResolvedCount;
			console.log(`  已记录 ${result.pendingFiles.length} 个待替换文件`);
		}
	} else {
		result.imagesReplaced = preResolvedCount;
	}

	return result;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		dryRun: false,
		verbose: true,
		namespace: '0',
		reset: false,
		disableSongboxLookup: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--quiet') {
			result.verbose = false;
		} else if (arg === '--namespace' && args[i + 1]) {
			result.namespace = args[i + 1];
			i++;
		} else if (arg === '--reset') {
			result.reset = true;
		} else if (arg === '--disable-songbox-lookup') {
			result.disableSongboxLookup = true;
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

	console.log('\n正在读取外部图片白名单...');
	const whitelist = await fetchWhitelist(zhApi);

	const templateNameMap = await buildTemplateNameMap(zhApi, templateImageConfig);

	const legalTitleRe = await fetchLegalTitleRegex(zhApi);

	const songboxNames = args.disableSongboxLookup
		? new Set<string>()
		: await fetchSongboxRedirects(zhApi);
	if (songboxNames.size > 0) {
		console.log(`  发现 ${songboxNames.size} 个 Songbox 模板变体`);
	}

	if (args.dryRun) {
		console.log('\n[试运行模式] 不会实际上传和编辑');
	}

	console.log(`\n正在遍历命名空间 ${args.namespace} 的页面...`);

	if (args.reset) {
		clearCheckpoint(args.namespace);
	}

	const initialApcontinue = args.reset ? null : loadCheckpoint(args.namespace);

	const stats: ProcessStats = {
		totalPages: 0,
		totalFound: 0,
		totalUploaded: 0,
		totalReplaced: 0,
		failedUploads: [],
	};

		const editFailures: PendingEditFailure[] = [];

	await processPagesInBatches(zhApi, args.namespace, async (pages) => {
		stats.totalPages += pages.length;

		for (const page of pages) {
			const result = await processPage(cmApi, zhApi, page, whitelist, args.dryRun, templateNameMap, legalTitleRe, songboxNames);

			stats.totalFound += result.imagesFound;
			stats.totalUploaded += result.imagesUploaded;
			stats.totalReplaced += result.imagesReplaced;

			if (result.uploadResults.some(u => !u.success)) {
				stats.failedUploads.push(...result.uploadResults.filter(u => !u.success));
			}

			if (result.editError && result.pendingFiles?.length) {
				editFailures.push({
					title: result.title,
					error: result.editError,
					files: result.pendingFiles,
				});
			}
		}
	}, initialApcontinue);

	console.log('\n========== 处理完成 ==========');
	console.log(`处理页面数: ${stats.totalPages}`);
	console.log(`发现外部图片: ${stats.totalFound}`);
	console.log(`成功上传: ${stats.totalUploaded}`);
	console.log(`成功替换: ${stats.totalReplaced}`);

	if (args.verbose && stats.failedUploads.length > 0) {
		console.log('\n失败的上传:');
		stats.failedUploads.forEach(u => {
			console.log(`  - ${u.filename}: ${u.error}`);
		});
	}

	if (editFailures.length > 0) {
		console.log(`\n编辑失败的页面: ${editFailures.length}`);
		for (const f of editFailures) {
			console.log(`  - ${f.title}: ${f.error}（${f.files.length} 个待替换文件）`);
		}
		savePendingFailures(args.namespace, editFailures);
	}

	console.log(`\nEnd time: ${new Date().toISOString()}`);
}

main().catch((error) => {
	console.error('发生错误:', error);
	process.exit(1);
});
