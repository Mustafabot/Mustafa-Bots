import { MediaWikiApi } from 'wiki-saikou';
import { createZhApi, createCmApi } from '../utils/createApi.js';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
import { withApiRetry } from '../utils/retry.js';

const PREFIX = '[AutoPatrol]';

interface RecentChange {
	rcid: number;
	user: string;
	tags: string[];
	title: string;
	namespace: number;
	timestamp: string;
}

type PatrolMode = 'edit' | 'moved' | 'all';

function parseArgs() {
	const argv = process.argv.slice(2);
	const modeArg = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] || 'all';
	const validModes: PatrolMode[] = ['edit', 'moved', 'all'];
	if (!validModes.includes(modeArg as PatrolMode)) {
		console.error(`${PREFIX} 无效的 --mode 值: ${modeArg}，有效值: ${validModes.join('|')}`);
		process.exit(1);
	}
	const wikiArg = argv.find((a) => a.startsWith('--wiki='))?.split('=')[1] || 'both';
	const validWikis = ['zh', 'cm', 'both'];
	if (!validWikis.includes(wikiArg)) {
		console.error(`${PREFIX} 无效的 --wiki 值: ${wikiArg}，有效值: ${validWikis.join('|')}`);
		process.exit(1);
	}
	return {
		dryRun: argv.includes('--dry-run'),
		verbose: argv.includes('--verbose'),
		days: parseInt(argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '30', 10),
		interval: parseInt(argv.find((a) => a.startsWith('--interval='))?.split('=')[1] || '4000', 10),
		limit: parseInt(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10),
		mode: modeArg as PatrolMode,
		wiki: wikiArg as 'zh' | 'cm' | 'both',
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

interface PhaseResult {
	successCount: number;
	skipCount: number;
	failures: string[];
	totalScanned: number;
	totalHit: number;
	totalSkipped: number;
}

interface MovedPhaseResult {
	successCount: number;
	skipCount: number;
	failures: string[];
	totalScanned: number;
	candidateCount: number;
	totalHit: number;
	totalSkipped: number;
}

interface MoveInfo {
	operator: string;
	targetTitle: string;
}

async function patrolEditPhase(
	api: MediaWikiApi,
	privilegedUsers: Set<string>,
	opts: { dryRun: boolean; verbose: boolean; days: number; interval: number; limit: number },
): Promise<PhaseResult> {
	const { dryRun, verbose, days, interval, limit } = opts;

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
							tags: 'Bot',
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

	return { successCount, skipCount, failures, totalScanned, totalHit, totalSkipped };
}

async function patrolMovedPhase(
	api: MediaWikiApi,
	privilegedUsers: Set<string>,
	opts: { dryRun: boolean; verbose: boolean; days: number; interval: number; limit: number },
): Promise<MovedPhaseResult> {
	const { dryRun, verbose, days, interval, limit } = opts;
	const rcEnd = new Date(Date.now() - days * 86400000).toISOString();

	console.log(`${PREFIX} 扫描近${days}天未巡查新页面 (namespace=0|10)...`);

	// 收集未巡查新页面
	const newPages: RecentChange[] = [];
	let rccontinue: string | undefined;
	let earliestTs = '';

	do {
		const params: Record<string, string | number> = {
			action: 'query',
			list: 'recentchanges',
			rcshow: 'unpatrolled',
			rctype: 'new',
			rcnamespace: '0|10',
			rcprop: 'ids|user|tags|title|timestamp',
			rclimit: 500,
			rcend: rcEnd,
		};
		if (rccontinue) params.rccontinue = rccontinue;

		const { data } = await api.post(params, { noCache: true } as Record<string, unknown>);
		const rcs: RecentChange[] = data.query?.recentchanges || [];

		for (const rc of rcs) {
			newPages.push(rc);
			if (!earliestTs || rc.timestamp < earliestTs) {
				earliestTs = rc.timestamp;
			}
		}

		rccontinue = data.continue?.rccontinue;
	} while (rccontinue);

	console.log(`${PREFIX} 未巡查新页面: ${newPages.length}条`);

	if (newPages.length === 0) {
		return { successCount: 0, skipCount: 0, failures: [], totalScanned: 0, candidateCount: 0, totalHit: 0, totalSkipped: 0 };
	}

	// 批量拉取移动日志
	console.log(`${PREFIX} 批量拉取移动日志...`);
	let movedPages: Map<string, MoveInfo>;
	try {
		movedPages = await fetchMoveLogMap(api, privilegedUsers, earliestTs);
	} catch (err) {
		console.error(`${PREFIX} 移动日志拉取失败，跳过阶段2: ${err instanceof Error ? err.message : String(err)}`);
		return { successCount: 0, skipCount: 0, failures: [], totalScanned: newPages.length, candidateCount: 0, totalHit: 0, totalSkipped: newPages.length };
	}

	console.log(`${PREFIX} 候选移动: ${movedPages.size}条`);

	// 交叉匹配并执行巡查
	let totalHit = 0;
	let totalSkipped = 0;
	let successCount = 0;
	let skipCount = 0;
	const failures: string[] = [];

	for (const rc of newPages) {
		const moveInfo = movedPages.get(rc.title);
		if (!moveInfo) {
			totalSkipped++;
			continue;
		}

		// 验证目标在创建者用户页下
		const creator = (rc.user || '').trim();
		const expectedPrefix = `User:${creator}/`;
		if (!moveInfo.targetTitle.startsWith(expectedPrefix)) {
			totalSkipped++;
			continue;
		}

		totalHit++;

		if (dryRun) {
			console.log(`  [DRY-RUN] rcid=${rc.rcid} 页面:${rc.title} (打回者:${moveInfo.operator} → ${moveInfo.targetTitle}) → 将巡逻`);
			continue;
		}

		if (limit > 0 && (successCount + skipCount) >= limit) {
			console.log(`${PREFIX} 已达限制 ${limit}，停止`);
			break;
		}

		try {
			await withApiRetry(
				() =>
					api.postWithToken('patrol', {
						action: 'patrol',
						rcid: rc.rcid,
						tags: 'Bot',
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
						if (verbose) console.log(`  rcid=${rc.rcid} 重试第${_attempt}次，等待${delay}ms`);
					},
				},
			);
			successCount++;
			if (verbose) console.log(`  rcid=${rc.rcid} 页面:${rc.title} → 已巡逻`);
		} catch (err: unknown) {
			skipCount++;
			const reason = err instanceof Error ? err.message : String(err);
			failures.push(`rcid=${rc.rcid} (${reason})`);
			if (verbose) {
				console.error(`  rcid=${rc.rcid} 页面:${rc.title} → 失败: ${reason}`);
			}
		}

		await sleep(randomInterval(interval));
	}

	return { successCount, skipCount, failures, totalScanned: newPages.length, candidateCount: movedPages.size, totalHit, totalSkipped };
}

async function fetchMoveLogMap(
	api: MediaWikiApi,
	privilegedUsers: Set<string>,
	rcEnd: string,
): Promise<Map<string, MoveInfo>> {
	const movedPages = new Map<string, MoveInfo>();
	let lecontinue: string | undefined;

	do {
		const params: Record<string, string | number> = {
			action: 'query',
			list: 'logevents',
			letype: 'move',
			ledir: 'newer',
			lestart: rcEnd,
			lelimit: 500,
		};
		if (lecontinue) params.lecontinue = lecontinue;

		const { data } = await api.post(params, { noCache: true } as Record<string, unknown>);
		const events = data.query?.logevents || [];

		for (const ev of events) {
			if (ev.ns !== 0 && ev.ns !== 10) continue;
			const operator = (ev.user || '').trim();
			if (!privilegedUsers.has(operator)) continue;

			const targetTitle: string = ev.params?.target_title || '';
			if (!targetTitle.startsWith('User:')) continue;

			const originalTitle: string = ev.title || '';
			if (!originalTitle || movedPages.has(originalTitle)) continue;

			movedPages.set(originalTitle, { operator, targetTitle });
		}

		lecontinue = data.continue?.lecontinue;
	} while (lecontinue);

	return movedPages;
}

interface WikiPatrolResult {
	label: 'zh' | 'cm';
	editPhase?: PhaseResult;
	movedPhase?: MovedPhaseResult;
}

async function runPatrolForWiki(
	label: 'zh' | 'cm',
	api: MediaWikiApi,
	privilegedUsers: Set<string>,
	opts: { dryRun: boolean; verbose: boolean; days: number; interval: number; limit: number },
	mode: PatrolMode,
): Promise<WikiPatrolResult> {
	const result: WikiPatrolResult = { label };

	if (mode === 'edit' || mode === 'all') {
		console.log(`${PREFIX}:${label} === 阶段1: 编辑巡查 ===`);
		result.editPhase = await patrolEditPhase(api, privilegedUsers, opts);
		console.log(`${PREFIX}:${label} 阶段1 扫描完成: ${result.editPhase.totalScanned}条未巡查, ${result.editPhase.totalHit}条命中, ${result.editPhase.totalSkipped}条跳过`);
		console.log(`${PREFIX}:${label} 阶段1 巡逻: 成功 ${result.editPhase.successCount}, 跳过 ${result.editPhase.skipCount}`);
		if (result.editPhase.failures.length > 0) {
			console.log(`${PREFIX}:${label} 阶段1 失败明细:`);
			for (const f of result.editPhase.failures) console.log(`  ${f}`);
		}
	}

	if ((mode === 'moved' || mode === 'all') && label === 'zh') {
		console.log(`${PREFIX}:${label} === 阶段2: 新页面打回巡查 ===`);
		result.movedPhase = await patrolMovedPhase(api, privilegedUsers, opts);
		console.log(`${PREFIX}:${label} 阶段2 扫描完成: ${result.movedPhase.totalScanned}条未巡查新页面, ${result.movedPhase.candidateCount}条候选, ${result.movedPhase.totalHit}条命中, ${result.movedPhase.totalSkipped}条跳过`);
		console.log(`${PREFIX}:${label} 阶段2 巡逻: 成功 ${result.movedPhase.successCount}, 跳过 ${result.movedPhase.skipCount}`);
		if (result.movedPhase.failures.length > 0) {
			console.log(`${PREFIX}:${label} 阶段2 失败明细:`);
			for (const f of result.movedPhase.failures) console.log(`  ${f}`);
		}
	} else if (label === 'cm') {
		console.log(`${PREFIX}:${label} (共享站跳过阶段2)`);
	}

	return result;
}

(async () => {
	const { dryRun, verbose, days, interval, limit, mode, wiki } = parseArgs();

	// ── 确定站点列表 ──
	const wikiLabels: ('zh' | 'cm')[] = wiki === 'both' ? ['zh', 'cm'] : [wiki];
	console.log(`${PREFIX} 目标站点: ${wikiLabels.join(' + ')}`);

	// ── 创建 zh API 并登录（用于拉取用户组） ──
	const zhApi = createZhApi();
	await clientlogin(
		zhApi,
		config.zh.bot.clientUsername || config.zh.bot.name,
		config.zh.bot.clientPassword,
	);

	// ── 预拉取用户组（两个站共享用户表，用 zh API） ──
	console.log(`${PREFIX} 预拉取用户组 (通过zh站)...`);
	const privilegedUsers = new Set<string>();

	const userGroups = ['sysop', 'patroller', 'goodeditor'] as const;
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

			const { data } = await zhApi.post(params);
			const users = data.query?.allusers || [];
			for (const u of users) {
				privilegedUsers.add(u.name.trim());
			}
			aufrom = data.continue?.aufrom;
		} while (aufrom);
	}

	console.log(`${PREFIX} sysop + patroller + goodeditor 去重后: ${privilegedUsers.size}`);

	const opts = { dryRun, verbose, days, interval, limit };

	// ── 遍历各站执行巡查 ──
	const allResults: WikiPatrolResult[] = [];

	for (const label of wikiLabels) {
		let api: MediaWikiApi;
		if (label === 'zh') {
			api = zhApi; // 复用已登录的 zh API
		} else {
			api = createCmApi();
			await clientlogin(
				api,
				config.cm.bot.clientUsername || config.cm.bot.name,
				config.cm.bot.clientPassword,
			);
		}

		const result = await runPatrolForWiki(label, api, privilegedUsers, opts, mode);
		allResults.push(result);
	}

	// ── 汇总 ──
	console.log(`${PREFIX} === 汇总 ===`);
	for (const r of allResults) {
		const editOk = r.editPhase ? `成功 ${r.editPhase.successCount}/跳过 ${r.editPhase.skipCount}` : '未执行';
		const movedOk = r.movedPhase
			? `成功 ${r.movedPhase.successCount}/跳过 ${r.movedPhase.skipCount}`
			: r.label === 'cm'
				? '跳过'
				: '未执行';
		console.log(`${PREFIX} ${r.label}: 阶段1 ${editOk}, 阶段2 ${movedOk}`);
	}
})();
