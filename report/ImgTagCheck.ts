import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import { writeFile } from 'fs/promises';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

interface Issue {
	title: string;
	message: string;
	line: number;
	col: number;
	src: string;
}

Parser.config = 'moegirl';
const NAMESPACE = '0';
const api = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie! },
});

const REPORT_TITLE = `User:没有羽翼的格雷塔/Report/ImgTag/Ns${NAMESPACE}`;

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

	const pages = await (async () => {
		const result: any[] = [];
		const eol: symbol = Symbol();
		let apcontinue: string | symbol | undefined = undefined;
		while (apcontinue !== eol) {
			const { data } = await api.post({
			action: 'query',
			prop: 'revisions',
			rvprop: 'content',
			generator: 'allpages',
			gapnamespace: NAMESPACE,
			gaplimit: 500,
			gapcontinue: apcontinue as string | undefined,
		}, {
			retry: 15,
		} as any) as any;
			apcontinue = data.continue?.gapcontinue ?? eol;
			console.log(`gapcontinue: ${apcontinue === eol ? 'END_OF_LIST' : String(apcontinue)}`);
			result.push(...Object.values(data.query.pages).filter((page: any) => page.revisions?.length));
		}
		console.log(`Total pages: ${result.length}`);
		return result;
	})();

	const issues: Issue[] = [];

	function traverse(node: any, title: string, issues: Issue[], whitelistRegexes: RegExp[]): void {
		if (!node) return;

		if (node.type === 'ext' && node.name === 'img') {
			const src: string | undefined = node.attributes?.src;
			if (src) {
				let isWhitelisted = whitelistRegexes.some(regex => regex.test(src!));
				if (!isWhitelisted && src.startsWith('//')) {
					isWhitelisted = whitelistRegexes.some(regex => regex.test('https:' + src!));
				}
				if (!isWhitelisted) {
					issues.push({
						title,
						message: 'img标签src属性不符合外部图像白名单',
						line: 0,
						col: 0,
						src,
					});
				}
			}
		}

		if (node.children && Array.isArray(node.children)) {
			for (const child of node.children) {
				traverse(child, title, issues, whitelistRegexes);
			}
		}
	}

	for (const page of pages) {
		const { title, revisions: [{ content }] }: { title: string; revisions: { content: string }[] } = page;
		console.log(`Checking ${title}`);

		const parsed: any = Parser.parse(content, title);

		traverse(parsed, title, issues, whitelistRegexes);
	}

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
