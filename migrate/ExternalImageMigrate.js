import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { URL } from 'url';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

Parser.config = 'moegirl';

const zhApi = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie },
});

const cmApi = new MediaWikiApi(config.cm.api, {
	headers: { cookie: config.cm.cookie },
});

const MAX_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：（测试）迁移外部图片到本地';

/**
 * @typedef {object} ImageIssue
 * @property {string} src - 图片URL
 * @property {object} node - wikiparser-node AST节点引用
 * @property {Record<string, string>} attributes - img标签的所有属性
 */

/**
 * @typedef {object} UploadResult
 * @property {string} filename - 新文件名
 * @property {string} url - 源URL
 * @property {boolean} success - 是否成功
 * @property {string} [error] - 错误信息
 * @property {object} [warnings] - 收到的警告信息
 * @property {boolean} [skipReplace] - 是否跳过替换
 * @property {string} [existingFile] - 已存在的文件名（用于duplicate情况）
 * @property {string} [action] - 采取的处理策略
 */

/**
 * @typedef {object} PageProcessResult
 * @property {string} title - 页面标题
 * @property {number} imagesFound - 发现的外部图片数
 * @property {number} imagesUploaded - 成功上传数
 * @property {number} imagesReplaced - 成功替换数
 * @property {UploadResult[]} uploadResults - 上传结果
 */

/**
 * 读取外部图像白名单
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @returns {Promise<RegExp[]>}
 */
async function fetchWhitelist(api) {
	const { data } = await api.post({
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: 'MediaWiki:External_image_whitelist',
	}, {
		retry: 15,
	});

	const page = Object.values(data.query.pages)[0];
	if (!page || !page.revisions) {
		console.error('Failed to get external image whitelist');
		return [];
	}

	const content = page.revisions[0].content;
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
		.filter(Boolean);

	console.log(`Loaded ${regexes.length} whitelist regexes`);
	return regexes;
}

/**
 * 分批遍历并处理页面
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} namespace
 * @param {function(Array<{title: string, content: string}>): Promise<void>} processBatch - 处理批次的回调函数
 */
async function processPagesInBatches(api, namespace, processBatch) {
	const eol = Symbol();
	let apcontinue = undefined;
	let batchIndex = 0;

	while (apcontinue !== eol) {
		const { data } = await api.post({
			action: 'query',
			prop: 'revisions',
			rvprop: 'content',
			generator: 'allpages',
			gapnamespace: namespace,
			gaplimit: 200,
			gapcontinue: apcontinue,
		}, {
			retry: 15,
		});

		apcontinue = data.continue?.gapcontinue ?? eol;
		batchIndex++;
		console.log(`\n=== 批次 ${batchIndex} ===`);
		console.log(`gapcontinue: ${apcontinue === eol ? 'END_OF_LIST' : apcontinue}`);

		const pages = Object.values(data.query.pages)
			.filter(page => page.revisions?.length)
			.map(page => ({
				title: page.title,
				content: page.revisions[0].content,
			}));

		console.log(`本批次页面数: ${pages.length}`);

		await processBatch(pages);
	}
}

/**
 * 从URL中提取文件扩展名
 * @param {string} url
 * @returns {string}
 */
function extractExtension(url) {
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname;
		const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
		return match ? `.${match[1]}` : '';
	} catch {
		return '';
	}
}

/**
 * 生成目标文件名
 * @param {string} url
 * @param {string} article
 * @param {number} index
 * @returns {string}
 */
function generateFilename(url, article, index) {
	const ext = extractExtension(url);
	return `File:${article} ${index}${ext}`;
}

/**
 * 生成改名后的文件名
 * @param {string} originalFilename - 原文件名（含File:前缀）
 * @param {number} suffix - 后缀数字
 * @returns {string}
 */
function generateRenamedFilename(originalFilename, suffix) {
	const match = originalFilename.match(/^(File:)(.+)(\.[a-zA-Z0-9]+)$/);
	if (match) {
		return `${match[1]}${match[2]} ${suffix}${match[3]}`;
	}
	return `${originalFilename} ${suffix}`;
}

/**
 * 解析上传警告并决定处理策略
 * @param {object} warnings - API返回的警告对象
 * @returns {{
 *   action: 'skip' | 'replace' | 'rename' | 'ignore',
 *   existingFile?: string,
 *   reason: string
 * }}
 */
function parseUploadWarnings(warnings) {
	const warningKeys = Object.keys(warnings);

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
		let existingFile = duplicateInfo;
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

	if (warningKeys.includes('exists')) {
		if (warningKeys.includes('no-change')) {
			return {
				action: 'replace',
				reason: '文件已存在且内容相同，跳过上传直接替换',
			};
		}
		if (warningKeys.includes('duplicateversions')) {
			return {
				action: 'replace',
				reason: '文件已存在（上传的是旧版本），跳过上传直接替换',
			};
		}
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

/**
 * 检查URL是否在白名单中
 * @param {string} src
 * @param {RegExp[]} whitelist
 * @returns {boolean}
 */
function isWhitelisted(src, whitelist) {
	if (whitelist.some(regex => regex.test(src))) {
		return true;
	}
	if (src.startsWith('//')) {
		return whitelist.some(regex => regex.test('https:' + src));
	}
	return false;
}

/**
 * 从页面内容中提取不合规的外部图片，并返回解析后的AST
 * @param {string} content
 * @param {string} title
 * @param {RegExp[]} whitelist
 * @returns {{ parsed: object, issues: ImageIssue[] }}
 */
function extractExternalImages(content, title, whitelist) {
	const issues = [];
	const parsed = Parser.parse(content, title);

	function traverse(node) {
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

/**
 * 上传单个文件
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} url
 * @param {string} filename
 * @param {string} comment
 * @param {boolean} dryRun
 * @param {string} article - 文章标题
 * @returns {Promise<UploadResult>}
 */
async function uploadFromUrl(api, url, filename, comment, dryRun, article) {
	if (dryRun) {
		console.log(`  [试运行] 将上传: ${filename}`);
		return { filename, url, success: true };
	}

	let lastError = null;
	let currentFilename = filename;
	let renameSuffix = 1;

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
					renameSuffix++;
					currentFilename = generateRenamedFilename(filename, renameSuffix);
					console.log(`  改名重试: ${currentFilename}`);
					attempt--;
					continue;
				}

				if (decision.action === 'ignore') {
					console.log('  忽略警告，强制上传...');
					try {
						const { data: forceData } = await api.postWithToken('csrf', {
							action: 'upload',
							filename: currentFilename,
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

						if (forceData.upload && forceData.upload.result === 'Success') {
							console.log('  强制上传成功');
							return { filename: currentFilename, url, success: true, warnings, action: decision.action };
						}
						if (JSON.stringify(forceData).includes('moderation-image-queued')) {
							console.log('  文件已进入审核队列');
							return { filename: currentFilename, url, success: true, warnings, action: decision.action };
						}
						console.log(`  强制上传失败: ${JSON.stringify(forceData)}`);
						return {
							filename: currentFilename,
							url,
							success: false,
							warnings,
							error: `强制上传失败: ${JSON.stringify(forceData)}`,
						};
					} catch (forceError) {
						if (forceError.message && forceError.message.includes('moderation-image-queued')) {
							console.log('  文件已进入审核队列');
							return { filename: currentFilename, url, success: true, warnings, action: decision.action };
						}
						console.log(`  强制上传失败: ${forceError.message}`);
						return {
							filename: currentFilename,
							url,
							success: false,
							warnings,
							error: `强制上传失败: ${forceError.message}`,
						};
					}
				}
			}

			throw new Error(JSON.stringify(data));
		} catch (error) {
			if (error.message && error.message.includes('moderation-image-queued')) {
				console.log('  文件已进入审核队列');
				return { filename: currentFilename, url, success: true };
			}
			lastError = error;
			if (attempt < MAX_RETRIES) {
				console.log(`  上传失败（${error.message}），第${attempt}次重试...`);
				await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
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

/**
 * 构建 {{UseImg}} 模板
 * @param {string} filename - 文件名（不含 File: 前缀）
 * @param {Record<string, string>} attributes - img标签的属性
 * @returns {string}
 */
function buildUseImgTemplate(filename, attributes) {
	const imgName = filename.replace(/^File:/i, '');
	const style = attributes.style || '';
	const title = attributes.title || '';
	const otherAttrs = { ...attributes };
	delete otherAttrs.src;
	delete otherAttrs.style;
	delete otherAttrs.title;

	let attrsStr = '';
	for (const [key, value] of Object.entries(otherAttrs)) {
		if (value) {
			const escapedValue = value.replace(/=/g, '{{=}}');
			attrsStr += ` ${key}=${escapedValue}`;
		}
	}

	let template = `{{useImg|img=${imgName}`;
	if (style) {
		template += `|style=${style}`;
	}
	if (title) {
		template += `|title=${title}`;
	}
	if (attrsStr) {
		template += `|attrs=${attrsStr.trim()}`;
	}
	template += '}}';

	return template;
}

/**
 * 使用AST操作替换外部图片节点为{{UseImg}}模板
 * @param {object} parsed - wikiparser-node解析后的AST根节点
 * @param {ImageIssue[]} issues - 图片问题列表
 * @param {Map<string, string>} urlToFilename - 原URL -> 新文件名的映射
 * @returns {string} 替换后的页面内容
 */
function replaceImageNodes(parsed, issues, urlToFilename) {
	for (const issue of issues) {
		const filename = urlToFilename.get(issue.src);
		if (!filename) continue;

		const useImgTemplate = buildUseImgTemplate(filename, issue.attributes);
		issue.node.replaceWith(useImgTemplate);
	}

	return parsed.toString();
}

/**
 * 编辑页面
 * @param {import('wiki-saikou').MediaWikiApi} api
 * @param {string} title
 * @param {string} content
 * @param {string} summary
 * @param {boolean} dryRun
 */
async function editPage(api, title, content, summary, dryRun) {
	if (dryRun) {
		console.log(`  [试运行] 将编辑页面: ${title}`);
		return;
	}

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
}

/**
 * 处理单个页面
 * @param {import('wiki-saikou').MediaWikiApi} uploadApi
 * @param {import('wiki-saikou').MediaWikiApi} editApi
 * @param {{title: string, content: string}} page
 * @param {RegExp[]} whitelist
 * @param {boolean} dryRun
 * @returns {Promise<PageProcessResult>}
 */
async function processPage(uploadApi, editApi, page, whitelist, dryRun) {
	const { title, content } = page;
	const result = {
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

	const srcToNodes = new Map();
	for (const issue of issues) {
		if (!srcToNodes.has(issue.src)) {
			srcToNodes.set(issue.src, []);
		}
		srcToNodes.get(issue.src).push(issue);
	}

	const uniqueSrcs = [...srcToNodes.keys()];
	console.log(`  去重后需上传 ${uniqueSrcs.length} 张图片`);

	const urlToFilename = new Map();

	for (let i = 0; i < uniqueSrcs.length; i++) {
		const src = uniqueSrcs[i];
		const index = i + 1;
		const filename = generateFilename(src, title, index);

		console.log(`  [${index}/${uniqueSrcs.length}] 上传: ${filename}`);
		console.log(`    来源: ${src}`);
		console.log(`    页面内引用次数: ${srcToNodes.get(src).length}`);

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
			continue;
		}

		if (uploadResult.success) {
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
			await editPage(editApi, title, newContent, DEFAULT_COMMENT, dryRun);
			result.imagesReplaced = issues.length;
			console.log('  页面编辑成功');
		} catch (error) {
			console.error(`  页面编辑失败: ${error.message}`);
		}
	}

	return result;
}

/**
 * 解析命令行参数
 * @param {string[]} args
 * @returns {{ dryRun: boolean, verbose: boolean, namespace: string }}
 */
function parseArgs(args) {
	const result = {
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

/**
 * 主函数
 */
async function main() {
	console.log(`Start time: ${new Date().toISOString()}`);

	const args = parseArgs(process.argv.slice(2));

	console.log('正在登录zh站...');
	await clientlogin(zhApi, config.zh.bot.clientUsername, config.zh.bot.clientPassword)
		.then((result) => { console.log('zh站登录成功', result); });

	console.log('正在登录commons站...');
	await clientlogin(cmApi, config.cm.bot.clientUsername, config.cm.bot.clientPassword, config.cm.api)
		.then((result) => { console.log('commons站登录成功', result); });

	console.log('\n正在读取外部图片白名单...');
	const whitelist = await fetchWhitelist(zhApi);

	if (args.dryRun) {
		console.log('\n[试运行模式] 不会实际上传和编辑');
	}

	console.log(`\n正在遍历命名空间 ${args.namespace} 的页面...`);

	const stats = {
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
