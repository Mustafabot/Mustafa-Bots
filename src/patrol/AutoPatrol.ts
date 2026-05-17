import { MediaWikiApi } from 'wiki-saikou';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { withApiRetry } from '../utils/retry.js';

const PREFIX = '[AutoPatrol]';

interface RecentChange {
	rcid: number;
	user: string;
	tags: string[];
}

function parseArgs() {
	const argv = process.argv.slice(2);
	return {
		dryRun: argv.includes('--dry-run'),
		verbose: argv.includes('--verbose'),
		days: parseInt(argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '30', 10),
		interval: parseInt(argv.find((a) => a.startsWith('--interval='))?.split('=')[1] || '4000', 10),
		limit: parseInt(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10),
	};
}

const TARGET_TAGS = new Set(['mw-reverted']);

function hasTargetTag(tags: string[]): boolean {
	return tags.some((t) => TARGET_TAGS.has(t));
}

function getTagReason(tags: string[]): string {
	const matched = tags.find((t) => TARGET_TAGS.has(t));
	return matched ? `标签:${matched}` : '';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInterval(baseInterval: number): number {
	return baseInterval - 1000 + Math.floor(Math.random() * 2000);
}

(async () => {
	const { dryRun, verbose, days, interval, limit } = parseArgs();

	const api = new MediaWikiApi(config.zh.api, {
		headers: { cookie: config.zh.cookie! },
	});

	await clientlogin(
		api,
		config.zh.bot.clientUsername || config.zh.bot.name,
		config.zh.bot.clientPassword,
	);

	// ── 预拉取用户组 ──
	console.log(`${PREFIX} 预拉取用户组...`);
	const privilegedUsers = new Set<string>();

	const userGroups = ['patroller', 'goodeditor'] as const;
	for (const group of userGroups) {
		let aufrom: string | undefined;
		do {
			const params: Record<string, string | number> = {
				action: 'query',
				list: 'allusers',
				augroup: group,
				aulimit: 500,
			};
			if (aufrom) params.aufrom = aufrom;

			const { data } = await api.post(params);
			const users = data.query?.allusers || [];
			for (const u of users) {
				privilegedUsers.add((u.name as string).trim());
			}
			aufrom = data.continue?.aufrom;
		} while (aufrom);
	}

	console.log(`${PREFIX} patroller + goodeditor 去重后: ${privilegedUsers.size}`);

	// ── 扫描未巡查编辑 ──
	const rcEnd = new Date(Date.now() - days * 86400000).toISOString();
	console.log(`${PREFIX} 扫描近${days}天未巡查编辑 (rcend=${rcEnd})...`);

	let rccontinue: string | undefined;
	let totalScanned = 0;
	let totalHit = 0;
	let totalSkipped = 0;
	let successCount = 0;
	let skipCount = 0;
	const failures: string[] = [];
	let pageNum = 0;

	outer: do {
		pageNum++;
		const params: Record<string, string | number> = {
			action: 'query',
			list: 'recentchanges',
			rcshow: 'unpatrolled',
			rctype: 'edit|new|log',
			rcprop: 'tags|user|ids',
			rclimit: 500,
			rcend: rcEnd,
		};
		if (rccontinue) params.rccontinue = rccontinue;

		const { data } = await api.post(params, { noCache: true } as Record<string, unknown>);
		const rcs: RecentChange[] = data.query?.recentchanges || [];
		totalScanned += rcs.length;

		if (verbose) console.log(`${PREFIX} 第${pageNum}页: ${rcs.length}条结果`);

		for (const rc of rcs) {
			const tags: string[] = rc.tags || [];
			const user = (rc.user || '').trim();
			const rcid = rc.rcid;

			const tagMatch = hasTargetTag(tags);
			const userMatch = privilegedUsers.has(user);

			if (!tagMatch && !userMatch) {
				totalSkipped++;
				continue;
			}

			totalHit++;

			if (dryRun) {
				const reason = tagMatch ? getTagReason(tags) : `用户组:${user}`;
				console.log(`  [DRY-RUN] rcid=${rcid} 用户:${user} (${reason}) → 将巡逻`);
				continue;
			}

			// 检查限制
			if (limit > 0 && (successCount + skipCount) >= limit) {
				console.log(`${PREFIX} 已达限制 ${limit}，停止`);
				break outer;
			}

			// 执行巡逻
			try {
				await withApiRetry(
					() =>
						api.postWithToken('patrol', {
							action: 'patrol',
							rcid,
							tags: 'Bot'
						}),
					{
						maxRetries: 3,
						shouldRetry: (_err, _attempt) => {
							const msg = _err.message.toLowerCase();
							if (msg.includes('permissiondenied')) {
								console.error(`${PREFIX} 权限不足，终止`);
								process.exit(1);
							}
							if (msg.includes('abusefilter')) return true;
							return _attempt < 3;
						},
						onRetry: (_attempt, delay) => {
							if (verbose) console.log(`  rcid=${rcid} 重试第${_attempt}次，等待${delay}ms`);
						},
					},
				);
				successCount++;
				if (verbose) console.log(`  rcid=${rcid} 用户:${user} → 已巡逻`);
			} catch (err: unknown) {
				skipCount++;
				const reason = err instanceof Error ? err.message : String(err);
				failures.push(`rcid=${rcid} (${reason})`);
				if (verbose) {
					console.error(`  rcid=${rcid} 用户:${user} → 失败: ${reason}`);
				}
			}

			// 巡逻间隔 (随机抖动)
			await sleep(randomInterval(interval));
		}

		rccontinue = data.continue?.rccontinue;
	} while (rccontinue && (!limit || (successCount + skipCount) < limit));

	// ── 汇总 ──
	console.log(`${PREFIX} 扫描完成: ${totalScanned}条未巡查, ${totalHit}条命中, ${totalSkipped}条跳过`);
	console.log(`${PREFIX} 巡逻: 成功 ${successCount}, 跳过 ${skipCount}`);
	if (failures.length > 0) {
		console.log(`${PREFIX} 失败明细:`);
		for (const f of failures) {
			console.log(`  ${f}`);
		}
	}
})();
