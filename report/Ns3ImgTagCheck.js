import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

Parser.config = 'moegirl';

const api = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.useragent },
});

const REPORT_TITLE = 'User:没有羽翼的格雷塔/Report/Ns3ImgTag';

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await clientlogin(api,
		config.zh.bot.clientUsername,
		config.zh.bot.clientPassword,
	).then(console.log);

	const pages = await (async () => {
		const result = [];
		const eol = Symbol();
		let apcontinue = undefined;
		while (apcontinue !== eol) {
			const { data } = await api.post({
				action: 'query',
				prop: 'revisions',
				rvprop: 'content',
				generator: 'allpages',
				gapnamespace: '3',
				gaplimit: 500,
				gapcontinue: apcontinue,
			}, {
				retry: 15,
			});
			apcontinue = data.continue?.gapcontinue ?? eol;
			console.log(`gapcontinue: ${apcontinue === eol ? 'END_OF_LIST' : apcontinue}`);
			result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
		}
		console.log(`Total pages: ${result.length}`);
		return result;
	})();

	const issues = [];

	for (const page of pages) {
		const { title, revisions: [{ content }] } = page;
		console.log(`Checking ${title}`);

		const parsed = Parser.parse(content, title);
		const lintErrors = parsed.lint();
		const imgTagIssues = lintErrors.filter((error) => {
			if (error.rule !== 'unmatched-tag') {
				return false;
			}
			const message = error.message.toLowerCase();
			return message.includes('img') || message.includes('<img');
		});

		if (imgTagIssues.length > 0) {
			for (const issue of imgTagIssues) {
				issues.push({
					title,
					message: issue.message,
					line: issue.startLine,
					col: issue.startCol,
					excerpt: issue.excerpt || '',
				});
			}
		}
	}

	console.log(`Found ${issues.length} issues`);

	const reportContent = generateReport(issues, pages.length);

	await api.postWithEditToken({
		action: 'edit',
		title: REPORT_TITLE,
		text: reportContent,
		summary: '更新未闭合img标签检查报告',
		bot: true,
		notminor: true,
		tags: 'Bot',
		watchlist: 'nochange',
	}).then(({ data }) => console.log(JSON.stringify(data)));

	console.log(`End time: ${new Date().toISOString()}`);
})();

function generateReport(issues, totalPages) {
	const now = new Date();
	const timestamp = now.toISOString();
	const dateStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

	let report = `== 未闭合img标签检查报告 ==

'''扫描时间''': ${dateStr} (UTC+8)

'''扫描页面总数''': ${totalPages}

'''发现问题数''': ${issues.length}

`;

	if (issues.length === 0) {
		report += `未发现未闭合的img标签问题。
`;
	} else {
		report += `=== 问题列表 ===

{| class="wikitable sortable"
! 页面 !! 问题描述 !! 行号 !! 列号
|-
`;
		for (const issue of issues) {
			const pageLink = `[[${issue.title}]]`;
			report += `| ${pageLink} || ${issue.message} || ${issue.line} || ${issue.col}
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
