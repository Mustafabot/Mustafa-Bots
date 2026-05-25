import Parser from 'wikiparser-node';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { createZhApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import templateImageConfig from '../../config/templateImageConfig.json' with { type: 'json' };
import { buildTemplateNameMap } from '../utils/templateRedirects.js';

interface Issue {
	title: string;
	message: string;
	line: number;
	col: number;
	src: string;
}

interface CheckpointData {
	stage: 'titles' | 'process';
	pageTitles: string[];
	gapContinue: string | undefined;
	processedTitles: string[];
	issues: Issue[];
}


function getCheckpointPath(): URL {
	return new URL(`../../data/checkpoint/Ns${NAMESPACE}_checkpoint.json`, import.meta.url);
}

async function loadCheckpoint(): Promise<CheckpointData | null> {
	try {
		const path = getCheckpointPath();
		const content = await import('fs/promises').then(fs => fs.readFile(path, 'utf-8'));
		return JSON.parse(content) as CheckpointData;
	} catch {
		return null;
	}
}

async function saveCheckpoint(data: CheckpointData): Promise<void> {
	const path = getCheckpointPath();
	await mkdir(new URL('.', path), { recursive: true });
	await import('fs/promises').then(fs => fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8'));
}

Parser.config = 'moegirl';
const NAMESPACE = '0';
const api = createZhApi();

const REPORT_TITLE = `User:没有羽翼的格雷塔/Report/ImgTag/Ns${NAMESPACE}`;

function isWhitelisted(src: string, whitelistRegexes: RegExp[]): boolean {
	if (whitelistRegexes.some(regex => regex.test(src))) {
		return true;
	}
	if (src.startsWith('//')) {
		return whitelistRegexes.some(regex => regex.test('https:' + src));
	}
	return false;
}

function processPage(
	title: string,
	content: string,
	whitelistRegexes: RegExp[],
	templateNameMap: Map<string, typeof templateImageConfig[number]>,
): Issue[] {
	const issues: Issue[] = [];
	const parsed = Parser.parse(content, title);
	const imgNodes = parsed.querySelectorAll<Parser.ExtToken>('ext#img');

	for (const node of imgNodes) {
		const src = node.attributes?.src;
		if (typeof src === 'string' && !isWhitelisted(src, whitelistRegexes)) {
			issues.push({
				title,
				message: 'img标签src属性不符合外部图像白名单',
				line: 0,
				col: 0,
				src,
			});
		}
	}

	const allTemplateNodes = parsed.querySelectorAll<Parser.TranscludeToken>('template');
	for (const templateNode of allTemplateNodes) {
		const name: string | undefined = templateNode.name;
		const normalizedName = name?.replace(/_/g, ' ');
		const templateConfig = normalizedName ? templateNameMap.get(normalizedName) : undefined;
		if (!templateConfig) continue;

		const imageValue: string | undefined = templateNode.getValue?.(templateConfig.externalImageParam)?.toString();
		if (imageValue && imageValue.trim() && !isWhitelisted(imageValue.trim(), whitelistRegexes)) {
			issues.push({
				title,
				message: `${templateConfig.templateName}模板${templateConfig.externalImageParam}参数不符合外部图像白名单`,
				line: 0,
				col: 0,
				src: imageValue.trim(),
			});
		}
	}

	return issues;
}

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);

	await clientlogin(api,
		config.zh.bot.clientUsername!,
		config.zh.bot.clientPassword!,
	).then(console.log);

	const whitelistRegexes: RegExp[] = await (async () => {
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
			.filter((line: string) => line.trim() && !line.trim().startsWith('#'))
			.map((line: string) => {
				try {
					return new RegExp(line.trim());
				} catch {
					console.error(`Invalid regex in whitelist: ${line}`);
					return null;
				}
			})
			.filter(Boolean) as RegExp[];
		console.log(regexes);
		console.log(`Loaded ${regexes.length} whitelist regexes`);
		return regexes;
	})();

	const templateNameMap = await buildTemplateNameMap(api, templateImageConfig);

	const checkpoint = await loadCheckpoint();
	let allPageTitles: string[] = [];
	let existingIssues: Issue[] = [];
	let processedTitlesSet: Set<string> = new Set();

	if (checkpoint) {
		console.log(`Found checkpoint at stage: ${checkpoint.stage}`);
		allPageTitles = checkpoint.pageTitles || [];
		existingIssues = checkpoint.issues || [];
		processedTitlesSet = new Set(checkpoint.processedTitles || []);
	}

	if (!checkpoint || checkpoint.stage === 'titles') {
		allPageTitles = [...(checkpoint?.pageTitles ?? [])];
		const eol: symbol = Symbol();
		let apcontinue: string | symbol | undefined = checkpoint?.gapContinue !== undefined ? checkpoint.gapContinue : undefined;

		while (apcontinue !== eol) {
			const { data } = await api.post({
				action: 'query',
				generator: 'allpages',
				gapnamespace: NAMESPACE,
				gaplimit: 500,
				gapcontinue: apcontinue as string | undefined,
			}, {
				retry: 15,
			} as any) as any;

			apcontinue = data.continue?.gapcontinue ?? eol;
			console.log(`gapcontinue: ${apcontinue === eol ? 'END_OF_LIST' : String(apcontinue)}`);

			const batchTitles = Object.values(data.query.pages).map((page: any) => page.title);
			allPageTitles.push(...batchTitles);
			console.log(`本批次获取 ${batchTitles.length} 个页面标题`);

			await saveCheckpoint({
				stage: 'titles',
				pageTitles: allPageTitles,
				gapContinue: apcontinue === eol ? undefined : apcontinue as string,
				processedTitles: [],
				issues: [],
			});
		}

		console.log(`共获取 ${allPageTitles.length} 个页面标题`);

		await saveCheckpoint({
			stage: 'titles',
			pageTitles: allPageTitles,
			gapContinue: undefined,
			processedTitles: [],
			issues: [],
		});
		console.log('Checkpoint saved after getting all page titles');
	}

	const accumulatedIssues: Issue[] = [...existingIssues];

	if (!checkpoint || checkpoint.stage === 'titles' || (checkpoint.stage as string) === 'contents' || checkpoint.stage === 'process') {
		console.log(`开始逐批获取内容并检查...`);

		const BATCH_SIZE = 50;
		const startIndex = checkpoint?.processedTitles?.length ?? 0;
		const allProcessedTitles: string[] = [...processedTitlesSet];

		for (let i = startIndex; i < allPageTitles.length; i += BATCH_SIZE) {
			const batch = allPageTitles.slice(i, i + BATCH_SIZE);

			const { data } = await api.post({
				action: 'query',
				prop: 'revisions',
				rvprop: 'content',
				titles: batch.join('|'),
			}, {
				retry: 15,
			} as any) as any;

			const batchPages = Object.values(data.query.pages)
				.filter((page: any) => page.revisions?.length) as Array<{ title: string; revisions: Array<{ content: string }> }>;

			for (const page of batchPages) {
				const { title, revisions: [{ content }] } = page;

				if (processedTitlesSet.has(title)) {
					continue;
				}

				const pageIssues = processPage(title, content, whitelistRegexes, templateNameMap);
				for (const issue of pageIssues) {
					const exists = accumulatedIssues.some(
						exist => exist.title === issue.title && exist.src === issue.src,
					);
					if (!exists) {
						accumulatedIssues.push(issue);
					}
				}

				processedTitlesSet.add(title);
				allProcessedTitles.push(title);
			}

			const progress = Math.min(i + BATCH_SIZE, allPageTitles.length);
			console.log(`处理进度: ${progress}/${allPageTitles.length} (本批次 ${batchPages.length} 个有效页面, 累计 ${accumulatedIssues.length} 个问题)`);

			await saveCheckpoint({
				stage: 'process',
				pageTitles: allPageTitles,
				gapContinue: undefined,
				processedTitles: allProcessedTitles,
				issues: accumulatedIssues,
			});
		}

		console.log(`全部页面检查完成，共发现 ${accumulatedIssues.length} 个问题`);
	}

	const issues = accumulatedIssues;

	console.log(`Found ${issues.length} issues`);

	const reportContent: string = generateReport(issues, allPageTitles.length);

	const localReportPath = new URL(`../../data/reports/Ns${NAMESPACE}ImgTagCheck_report.txt`, import.meta.url);
	await mkdir(new URL('.', localReportPath), { recursive: true });
	await writeFile(localReportPath, reportContent, 'utf-8');
	console.log(`Report saved to local file: ${localReportPath}`);

	const BATCH_SIZE = 200;
	const totalBatches = Math.ceil(issues.length / BATCH_SIZE);

	for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
		const start = batchIndex * BATCH_SIZE;
		const end = Math.min(start + BATCH_SIZE, issues.length);
		const batchIssues = issues.slice(start, end);
		const batchReportContent = generateBatchReport(batchIssues, allPageTitles.length, batchIndex, totalBatches);

		const batchTitle = `${REPORT_TITLE}/${batchIndex + 1}`;

		console.log(`Submitting batch ${batchIndex + 1}/${totalBatches} (${batchIssues.length} issues)`);

		const editResult = await api.postWithToken('csrf', {
			action: 'edit',
			title: batchTitle,
			text: batchReportContent,
			summary: `更新NS${NAMESPACE}外部图片报告（第${batchIndex + 1}/${totalBatches}批）`,
			bot: true,
			notminor: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}, {
			retry: 500,
			noCache: true,
		});
		const { data } = editResult;
		if (data.error) {
			console.error(`提交第 ${batchIndex + 1}/${totalBatches} 批报告失败:`, JSON.stringify(data.error));
			throw new Error(`编辑失败: ${data.error.code}: ${data.error.text}`);
		}
		console.log(`第 ${batchIndex + 1}/${totalBatches} 批报告提交成功:`, JSON.stringify(data));
	}

	const checkpointPath = getCheckpointPath();
	try {
		await unlink(checkpointPath);
		console.log(`Checkpoint file deleted: ${checkpointPath.pathname}`);
	} catch (err: any) {
		if (err.code !== 'ENOENT') {
			console.error(`Failed to delete checkpoint file: ${err.message}`);
		}
	}

	console.log(`End time: ${new Date().toISOString()}`);
})().catch((err: Error) => {
	console.error('脚本执行失败:', err);
	process.exit(1);
});

function generateReport(issues: Issue[], totalPages: number): string {
	const now = new Date();
	const timestamp = now.toISOString();
	const dateStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

	let report = `== 外部图像白名单检查报告 ==

'''扫描时间''': ${dateStr} (UTC+8)

'''扫描页面总数''': ${totalPages}

'''发现问题数''': ${issues.length}

`;

	if (issues.length === 0) {
		report += `未发现不符合外部图像白名单的问题。
`;
	} else {
		report += `=== 问题列表 ===

{| class="wikitable sortable"
! 页面 !! 问题描述 !! 行号 !! 列号 !! src属性
|-
`;
		for (const issue of issues) {
			const pageLink = `[[${issue.title}]]`;
			const src = issue.src || '';
			report += `| ${pageLink} || ${issue.message} || ${issue.line} || ${issue.col} || ${src}
|-
`;
		}
		report += `|}
`;
	}

	report += `
----
'''生成时间''': ${timestamp}
`;

	return report;
}

function generateBatchReport(batchIssues: Issue[], totalPages: number, batchIndex: number, totalBatches: number): string {
	const now = new Date();
	const timestamp = now.toISOString();
	const dateStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

	let report = `== 外部图像白名单检查报告 ==

'''扫描时间''': ${dateStr} (UTC+8)

'''扫描页面总数''': ${totalPages}

'''发现问题数''': ${batchIssues.length}（第${batchIndex + 1}批，共${totalBatches}批）

`;

	if (batchIssues.length === 0) {
		report += `未发现不符合外部图像白名单的问题。
`;
	} else {
		report += `=== 问题列表 ===

{| class="wikitable sortable"
! 页面 !! 问题描述 !! 行号 !! 列号 !! src属性
|-
`;
		for (const issue of batchIssues) {
			const pageLink = `[[${issue.title}]]`;
			const src = issue.src || '';
			report += `| ${pageLink} || ${issue.message} || ${issue.line} || ${issue.col} || ${src}
|-
`;
		}
		report += `|}
`;
	}

	report += `
----
'''生成时间''': ${timestamp}
'''批次信息''': 第${batchIndex + 1}页，共${totalBatches}页
`;

	return report;
}


