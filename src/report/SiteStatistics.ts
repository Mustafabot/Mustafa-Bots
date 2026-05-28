import { createZhApi, createCmApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import type { MediaWikiApi } from 'wiki-saikou';

const PREFIX = '[SiteStatistics]';

function parseArgs() {
	const argv = process.argv.slice(2);
	return {
		dryRun: argv.includes('--dry-run'),
		verbose: argv.includes('--verbose'),
	};
}

async function queryStatistics(api: MediaWikiApi, label: string, verbose: boolean): Promise<Record<string, number>> {
	const { data } = await api.post({
		action: 'query',
		format: 'json',
		meta: 'siteinfo',
		siprop: 'statistics',
	});

	if (verbose) {
		console.log(`${PREFIX} ${label} 原始响应:`, JSON.stringify(data, null, 2));
	}

	const stats = (data as any)?.query?.statistics;
	return {
		pages: stats?.pages ?? 0,
		articles: stats?.articles ?? 0,
		edits: stats?.edits ?? 0,
		activeusers: stats?.activeusers ?? 0,
		admins: stats?.admins ?? 0,
		images: stats?.images ?? 0,
	};
}

(async () => {
	console.log(`${PREFIX} 开始时间: ${new Date().toISOString()}`);

	const { dryRun, verbose } = parseArgs();
	if (verbose) {
		console.log(`${PREFIX} dryRun=${dryRun}`);
	}

	const zhApi = createZhApi();
	const cmApi = createCmApi();

	// 查询两个站点统计
	const zhStats = await queryStatistics(zhApi, '主站(zh)', verbose);
	const cmStats = await queryStatistics(cmApi, '共享站(cm)', verbose);

	if (verbose) {
		console.log(`${PREFIX} 主站: pages=${zhStats.pages} articles=${zhStats.articles} edits=${zhStats.edits} activeusers=${zhStats.activeusers} admins=${zhStats.admins}`);
		console.log(`${PREFIX} 共享站: images=${cmStats.images}`);
	}

	// 构造替换引用：{{subst:User:没有羽翼的格雷塔/statistics|pages|articles|edits|activeusers|images}}
	const wikitext = `{{subst:User:没有羽翼的格雷塔/statistics|${zhStats.pages}|${zhStats.articles}|${zhStats.edits}|${zhStats.activeusers}|${cmStats.images}}}`;

	console.log(`${PREFIX} 生成的wikitext:`);
	console.log(wikitext);

	if (dryRun) {
		console.log(`${PREFIX} [DRY-RUN] 跳过写入wiki页面`);
		console.log(`${PREFIX} 结束时间: ${new Date().toISOString()}`);
		return;
	}

	// 登录并写入wiki
	const api = createZhApi();
	await clientlogin(api,
		config.zh.bot.clientUsername!,
		config.zh.bot.clientPassword!,
	);

	const REPORT_TITLE = 'User:没有羽翼的格雷塔/Report/statistics';

	const editResult = await api.postWithToken('csrf', {
		action: 'edit',
		title: REPORT_TITLE,
		appendtext: wikitext,
		summary: '机器人：更新站点统计数据',
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
		console.error(`${PREFIX} 写入报告失败:`, JSON.stringify(data.error));
		throw new Error(`编辑失败: ${data.error.code}: ${data.error.text}`);
	}
	console.log(`${PREFIX} 报告写入成功:`, JSON.stringify(data));

	console.log(`${PREFIX} 结束时间: ${new Date().toISOString()}`);
})().catch((err: Error) => {
	console.error(`${PREFIX} 脚本执行失败:`, err);
	process.exit(1);
});
