import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { URL } from 'url';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

Parser.config = 'moegirl';

interface ImageIssue {
	src: string;
	node: any;
	attributes: Record<string, string>;
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
}

const zhApi = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie! },
});

const cmApi = new MediaWikiApi(config.cm.api, {
	headers: { cookie: config.cm.cookie! },
});

const MAX_RETRIES = 3;
const MAX_RENAME_ATTEMPTS = 10;
const FORCE_UPLOAD_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：自其他网站迁移文件';

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

function changeFileExtension(filename: string, newExt: string): string {
	const match = filename.match(/^(File:.+)(\.[a-zA-Z0-9]+)$/);
	if (match) {
		return `${match[1]}${newExt}`;
	}
	return `${filename}${newExt}`;
}

async function detectMimeFromUrl(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, { method: 'HEAD' });
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
	const { data } = await api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: 'MediaWiki:External_image_whitelist',
	}, {
		retry: 15,
	} as any);

	const page = Object.values(data.query.pages)[0] as any;
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

async function processPagesInBatches(
	api: MediaWikiApi,
	namespace: string,
	processBatch: (pages: PageInfo[]) => Promise<void>
): Promise<void> {
	const eol = Symbol();
	let apcontinue: string | symbol | undefined = undefined;
	let batchIndex = 0;

	while (apcontinue !== eol) {
		const { data } = await api.post({
			action: 'query',
			prop: 'revisions',
			rvprop: 'content',
			generator: 'allpages',
			gapnamespace: namespace,
			gaplimit: 500,
			gapcontinue: apcontinue as string | undefined,
		}, {
			retry: 15,
		} as any) as any;

		apcontinue = (data as any).continue?.gapcontinue ?? eol;
		batchIndex++;
		console.log(`\n=== 批次 ${batchIndex} ===`);
		console.log(`gapcontinue: ${apcontinue === eol ? 'END_OF_LIST' : String(apcontinue)}`);

		const pages: PageInfo[] = Object.values(data.query.pages)
			.filter((page: any) => page.revisions?.length)
			.map((page: any) => ({
				title: page.title,
				content: page.revisions[0].content,
			}));

		console.log(`本批次页面数: ${pages.length}`);

		await processBatch(pages);
	}
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

function generateFilename(url: string, article: string, index: number): string {
	const ext = extractExtension(url);
	return `File:${article} ${index}${ext}`;
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

function extractExternalImages(content: string, title: string, whitelist: RegExp[]): { parsed: any; issues: ImageIssue[] } {
	const issues: ImageIssue[] = [];
	const parsed = Parser.parse(content, title);

	function traverse(node: any): void {
		if (!node) return;

		if (node.type === 'ext' && node.name === 'img') {
			const src = node.attributes?.src;
			if (src && !isWhitelisted(src, whitelist)) {
				issues.push({
					src,
					node,
					attributes: { ...node.attributes },
				});
			}
		}

		if (node.children && Array.isArray(node.children)) {
			for (const child of node.children) {
				traverse(child);
			}
		}
	}

	traverse(parsed);
	return { parsed, issues };
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
	let forceLastError: Error | null = null;
	for (let forceAttempt = 1; forceAttempt <= FORCE_UPLOAD_RETRIES; forceAttempt++) {
		try {
			const { data: forceData } = await api.postWithToken('csrf', {
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
			});

			if ((forceData as any).upload && (forceData as any).upload.result === 'Success') {
				console.log('  强制上传成功');
				return { filename, url, success: true, warnings, action: 'ignore' };
			}
			if (JSON.stringify(forceData).includes('moderation-image-queued')) {
				console.log('  文件已进入审核队列');
				return { filename, url, success: true, warnings, action: 'ignore' };
			}
			console.log(`  强制上传失败: ${JSON.stringify(forceData)}`);
			forceLastError = new Error(`强制上传失败: ${JSON.stringify(forceData)}`);
		} catch (forceError: any) {
			if (forceError.message && forceError.message.includes('moderation-image-queued')) {
				console.log('  文件已进入审核队列');
				return { filename, url, success: true, warnings, action: 'ignore' };
			}
			forceLastError = forceError;
		}
		if (forceAttempt < FORCE_UPLOAD_RETRIES) {
			console.log(`  强制上传第${forceAttempt}次重试...`);
			await new Promise(resolve => setTimeout(resolve, 1000 * forceAttempt));
		}
	}
	return {
		filename,
		url,
		success: false,
		warnings,
		error: `强制上传失败: ${forceLastError?.message || '未知错误'}`,
	};
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

	let lastError: Error | null = null;
	let currentFilename = filename;
	let renameSuffix = 1;
	let renameAttempts = 0;

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

			if ((data as any).upload && (data as any).upload.result === 'Success') {
				if ((data as any).upload.warnings) {
					console.log('  警告: 文件已存在，已被覆盖');
				}
				return { filename: currentFilename, url, success: true };
			}

			if ((data as any).upload && (data as any).upload.result === 'Warning' && (data as any).upload.warnings) {
				const warnings = (data as any).upload.warnings;
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
			if (error.message && error.message.includes('moderation-image-queued')) {
				console.log('  文件已进入审核队列');
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
			const isAbuseFilter = error.message && error.message.toLowerCase().includes('abusefilter');
			if (attempt < MAX_RETRIES) {
				if (isAbuseFilter) {
					console.log(`  遇到滥用过滤器警告，第${attempt}次重试...`);
				} else {
					console.log(`  上传失败（${error.message}），第${attempt}次重试...`);
				}
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
				continue;
			}
		}
	}

	return {
		filename: currentFilename,
		url,
		success: false,
		error: lastError?.message || '未知错误',
	};
}

function buildUseImgTemplateNode(filename: string, attributes: Record<string, string>, refNode: any): any {
	const imgName = filename.replace(/^File:/i, '');
	const style = attributes.style || '';
	const title = attributes.title || '';
	const otherAttrs: Record<string, string> = { ...attributes };
	delete otherAttrs.src;
	delete otherAttrs.style;
	delete otherAttrs.title;

	const nodeConfig = refNode.getAttribute('config');
	const templateNode = Parser.parse('{{useImg}}', refNode.getAttribute('include'), 7, nodeConfig)
		.querySelector('template') as any;
	templateNode.setValue('img', imgName);
	if (style) {
		templateNode.setValue('style', style);
	}
	if (title) {
		templateNode.setValue('title', title);
	}
	let attrsStr = '';
	for (const [key, value] of Object.entries(otherAttrs)) {
		if (value) {
			attrsStr += ` ${key}=${value}`;
		}
	}
	if (attrsStr) {
		const attrsParam = templateNode.newAnonArg(attrsStr.trim());
		attrsParam.rename('attrs');
		attrsParam.escape();
	}

	return templateNode;
}

function replaceImageNodes(parsed: any, issues: ImageIssue[], urlToFilename: Map<string, string>): string {
	for (const issue of issues) {
		const filename = urlToFilename.get(issue.src);
		if (!filename) continue;

		const templateNode = buildUseImgTemplateNode(filename, issue.attributes, parsed);
		issue.node.replaceWith(templateNode);
	}

	return parsed.toString();
}

async function editPage(api: MediaWikiApi, title: string, content: string, summary: string, dryRun: boolean): Promise<void> {
	if (dryRun) {
		console.log(`  [试运行] 将编辑页面: ${title}`);
		return;
	}

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			await api.postWithToken('csrf', {
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
			});
			return;
		} catch (error: any) {
			lastError = error;
			const isAbuseFilter = error.message && error.message.toLowerCase().includes('abusefilter');
			if (attempt < MAX_RETRIES) {
				if (isAbuseFilter) {
					console.log(`  编辑遇到滥用过滤器警告，第${attempt}次重试...`);
				} else {
					console.log(`  编辑失败（${error.message}），第${attempt}次重试...`);
				}
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
				continue;
			}
			throw error;
		}
	}
	throw lastError;
}

async function processPage(
	uploadApi: MediaWikiApi,
	editApi: MediaWikiApi,
	page: PageInfo,
	whitelist: RegExp[],
	dryRun: boolean
): Promise<PageProcessResult> {
	const { title, content } = page;
	const result: PageProcessResult = {
		title,
		imagesFound: 0,
		imagesUploaded: 0,
		imagesReplaced: 0,
		uploadResults: [],
	};

	console.log(`\n处理页面: ${title}`);

	const { parsed, issues } = extractExternalImages(content, title, whitelist);
	result.imagesFound = issues.length;

	if (issues.length === 0) {
		console.log('  无外部图片需要处理');
		return result;
	}

	console.log(`  发现 ${issues.length} 个外部图片标签`);

	const srcToNodes = new Map<string, ImageIssue[]>();
	for (const issue of issues) {
		if (!srcToNodes.has(issue.src)) {
			srcToNodes.set(issue.src, []);
		}
		srcToNodes.get(issue.src)!.push(issue);
	}

	const uniqueSrcs = [...srcToNodes.keys()];
	console.log(`  去重后需上传 ${uniqueSrcs.length} 张图片`);

	const urlToFilename = new Map<string, string>();

	for (let i = 0; i < uniqueSrcs.length; i++) {
		const src = uniqueSrcs[i];
		const index = i + 1;
		const filename = generateFilename(src, title, index);

		console.log(`  [${index}/${uniqueSrcs.length}] 上传: ${filename}`);
		console.log(`    来源: ${src}`);
		console.log(`    页面内引用次数: ${srcToNodes.get(src)!.length}`);

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

	if (urlToFilename.size > 0) {
		console.log(`  替换页面中的 ${issues.length} 个图片标签...`);
		const newContent = replaceImageNodes(parsed, issues, urlToFilename);

		try {
			await editPage(editApi, title, newContent, DEFAULT_COMMENT + `（${issues.length}个）`, dryRun);
			result.imagesReplaced = issues.length;
			console.log('  页面编辑成功');
		} catch (error: any) {
			console.error(`  页面编辑失败: ${error.message}`);
			result.editError = error.message;
			result.pendingFiles = [...urlToFilename.entries()];
			console.log(`  已记录 ${result.pendingFiles.length} 个待替换文件`);
		}
	}

	return result;
}

function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		dryRun: false,
		verbose: false,
		namespace: '0',
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--verbose') {
			result.verbose = true;
		} else if (arg === '--namespace' && args[i + 1]) {
			result.namespace = args[i + 1];
			i++;
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

	console.log('\n正在读取外部图片白名单...');
	const whitelist = await fetchWhitelist(zhApi);

	if (args.dryRun) {
		console.log('\n[试运行模式] 不会实际上传和编辑');
	}

	console.log(`\n正在遍历命名空间 ${args.namespace} 的页面...`);

	const stats: ProcessStats = {
		totalPages: 0,
		totalFound: 0,
		totalUploaded: 0,
		totalReplaced: 0,
		failedUploads: [],
	};

	await processPagesInBatches(zhApi, args.namespace, async (pages) => {
		stats.totalPages += pages.length;

		for (const page of pages) {
			const result = await processPage(cmApi, zhApi, page, whitelist, args.dryRun);

			stats.totalFound += result.imagesFound;
			stats.totalUploaded += result.imagesUploaded;
			stats.totalReplaced += result.imagesReplaced;

			if (result.uploadResults.some(u => !u.success)) {
				stats.failedUploads.push(...result.uploadResults.filter(u => !u.success));
			}
		}
	});

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

	console.log(`\nEnd time: ${new Date().toISOString()}`);
}

main().catch((error) => {
	console.error('发生错误:', error);
	process.exit(1);
});
