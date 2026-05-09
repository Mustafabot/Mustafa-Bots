import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { writeFile } from 'fs/promises';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import templateImageConfig from '../templateImageConfig.json' with { type: 'json' };

interface Issue {
	title: string;
	message: string;
	line: number;
	col: number;
	src: string;
}

interface CheckpointData {
	stage: 'titles' | 'contents' | 'process';
	pageTitles: string[];
	pagesWithContent: Array<{ title: string; revisions: Array<{ content: string }> }>;
	processedTitles: string[];
	issues: Issue[];
}

const CHECKPOINT_INTERVAL = 100;


function getCheckpointPath(): URL {
	return new URL(`./Ns${NAMESPACE}_checkpoint.json`, import.meta.url);
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
	await import('fs/promises').then(fs => fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8'));
}

Parser.config = 'moegirl';
const NAMESPACE = '0';
const CONCURRENCY = 10;
const api = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie! },
});

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
): Issue[] {
	const issues: Issue[] = [];
	const parsed = Parser.parse(content, title);
	const imgNodes = parsed.querySelectorAll('ext#img') as any[];

	for (const node of imgNodes) {
		const src: string | undefined = node.attributes?.src;
		if (src && !isWhitelisted(src, whitelistRegexes)) {
			issues.push({
				title,
				message: 'img标签src属性不符合外部图像白名单',
				line: 0,
				col: 0,
				src,
			});
		}
	}

	for (const templateConfig of templateImageConfig) {
		const templateNodes = parsed.querySelectorAll(`template#${templateConfig.templateName}`) as any[];
		for (const templateNode of templateNodes) {
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
	}

	return issues;
}

async function processPagesParallel(
	pages: Array<{ title: string; revisions: Array<{ content: string }> }>,
	whitelistRegexes: RegExp[],
	concurrency: number,
	processedTitles: Set<string>,
	onCheckpoint: (processedCount: number, newIssues: Issue[], newProcessedTitles: string[]) => void,
): Promise<Issue[]> {
	const allIssues: Issue[] = [];
	const newProcessedTitles: string[] = [];
	const queue = [...pages];
	const total = pages.length + processedTitles.size;
	let processed = processedTitles.size;
	const startTime = Date.now();
	let lastCheckpointCount = processed;

	async function worker(): Promise<void> {
		while (queue.length > 0) {
			const page = queue.shift();
			if (!page) break;

			const { title, revisions: [{ content }] } = page;
			if (processedTitles.has(title)) {
				continue;
			}

			const issues = processPage(title, content, whitelistRegexes);
			allIssues.push(...issues);
			newProcessedTitles.push(title);

			processed++;
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			const percent = ((processed / total) * 100).toFixed(1);
			const remaining = queue.length;
			console.log(`[${processed}/${total}] ${percent}% | ${remaining} remaining | ${elapsed}s elapsed | ${title}`);

			if (processed - lastCheckpointCount >= CHECKPOINT_INTERVAL) {
				onCheckpoint(processed, allIssues, newProcessedTitles);
				lastCheckpointCount = processed;
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, pages.length) }, () =>
		worker(),
	);

	await Promise.all(workers);

	if (newProcessedTitles.length > 0) {
		onCheckpoint(processed, allIssues, newProcessedTitles);
	}

	return allIssues;
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

	const checkpoint = await loadCheckpoint();
	let allPageTitles: string[] = [];
	let pages: Array<{ title: string; revisions: Array<{ content: string }> }> = [];
	let existingIssues: Issue[] = [];
	let processedTitlesSet: Set<string> = new Set();

	if (checkpoint) {
		console.log(`Found checkpoint at stage: ${checkpoint.stage}`);
		allPageTitles = checkpoint.pageTitles || [];
		pages = checkpoint.pagesWithContent || [];
		existingIssues = checkpoint.issues || [];
		processedTitlesSet = new Set(checkpoint.processedTitles || []);
	}

	if (!checkpoint || checkpoint.stage === undefined) {
		allPageTitles = await (async () => {
			const titles: string[] = [];
			const eol: symbol = Symbol();
			let apcontinue: string | symbol | undefined = undefined;

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
				titles.push(...batchTitles);
				console.log(`本批次获取 ${batchTitles.length} 个页面标题`);

				await saveCheckpoint({
					stage: 'titles',
					pageTitles: titles,
					pagesWithContent: [],
					processedTitles: [],
					issues: [],
				});
				console.log(`Checkpoint saved: ${titles.length} page titles collected`);
			}

			console.log(`共获取 ${titles.length} 个页面标题`);
			return titles;
		})();
	}

	if (!checkpoint || checkpoint.stage === 'titles') {
		console.log(`开始获取页面内容...`);

		const result: Array<{ title: string; revisions: Array<{ content: string }> }> = [];
		const BATCH_SIZE = 50;

		for (let i = 0; i < allPageTitles.length; i += BATCH_SIZE) {
			const batch = allPageTitles.slice(i, i + BATCH_SIZE);
			const { data } = await api.post({
				action: 'query',
				prop: 'revisions',
				rvprop: 'content',
				titles: batch.join('|'),
			}, {
				retry: 15,
			} as any) as any;

			const batchPages = Object.values(data.query.pages).filter((page: any) => page.revisions?.length) as Array<{ title: string; revisions: Array<{ content: string }> }>;
			result.push(...batchPages);
			console.log(`获取内容进度: ${Math.min(i + BATCH_SIZE, allPageTitles.length)}/${allPageTitles.length} (本批次 ${batchPages.length} 个有效页面)`);

			pages = result;
			await saveCheckpoint({
				stage: 'contents',
				pageTitles: allPageTitles,
				pagesWithContent: pages,
				processedTitles: [],
				issues: [],
			});
			console.log(`Checkpoint saved: ${pages.length} page contents fetched`);
		}

		console.log(`Total pages: ${result.length}`);
	}

	const allProcessedTitles: string[] = [...processedTitlesSet];
	const accumulatedIssues: Issue[] = [...existingIssues];

	async function handleCheckpoint(
		processedCount: number,
		newIssues: Issue[],
		newProcessed: string[],
	): Promise<void> {
		for (const title of newProcessed) {
			if (!processedTitlesSet.has(title)) {
				processedTitlesSet.add(title);
				allProcessedTitles.push(title);
			}
		}
		for (const issue of newIssues) {
			const exists = accumulatedIssues.some(
				i => i.title === issue.title && i.src === issue.src,
			);
			if (!exists) {
				accumulatedIssues.push(issue);
			}
		}
		await saveCheckpoint({
			stage: 'process',
			pageTitles: allPageTitles,
			pagesWithContent: pages,
			processedTitles: allProcessedTitles,
			issues: accumulatedIssues,
		});
		console.log(`Checkpoint saved: ${processedCount} pages processed, ${accumulatedIssues.length} issues found`);
	}

	console.log(`Starting parallel processing with concurrency: ${CONCURRENCY}`);
	const newIssues = await processPagesParallel(
		pages,
		whitelistRegexes,
		CONCURRENCY,
		processedTitlesSet,
		handleCheckpoint,
	);

	const issues = [...existingIssues, ...newIssues];

	console.log(`Found ${issues.length} issues`);

	const reportContent: string = generateReport(issues, pages.length);

	const localReportPath = new URL(`./Ns${NAMESPACE}ImgTagCheck_report.txt`, import.meta.url);
	await writeFile(localReportPath, reportContent, 'utf-8');
	console.log(`Report saved to local file: ${localReportPath}`);

	const BATCH_SIZE = 200;
	const totalBatches = Math.ceil(issues.length / BATCH_SIZE);

	for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
		const start = batchIndex * BATCH_SIZE;
		const end = Math.min(start + BATCH_SIZE, issues.length);
		const batchIssues = issues.slice(start, end);
		const batchReportContent = generateBatchReport(batchIssues, pages.length, batchIndex, totalBatches);

		const batchTitle = `${REPORT_TITLE}/${batchIndex + 1}`;

		console.log(`Submitting batch ${batchIndex + 1}/${totalBatches} (${batchIssues.length} issues)`);

		await api.postWithToken('csrf', {
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
		}).then(({ data }) => console.log(JSON.stringify(data)));
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();

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
