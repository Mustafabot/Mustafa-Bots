import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { MediaWikiApi, MwApiResponse } from 'wiki-saikou';
import type { ApiPage, ApiQueryResponse } from 'types-mediawiki-response';
import { extractApiError } from './retry.js';

/** 镜像页面记录（pages 表的一行） */
export interface MirrorPage {
	/** 页面标题 */
	title: string;
	/** 页面 ID */
	pageid: number;
	/** 命名空间编号 */
	ns: number;
	/** 最新修订版本 ID（增量比对的依据） */
	revid: number;
	/** 页面源代码（原始 wikitext，保留 HTML 注释——替换需要编辑真实内容） */
	text: string;
}

/** 全量同步进度：键为命名空间编号，true 表示已完成，字符串为待续传的 gapcontinue */
type SyncProgress = Record<string, string | true>;

/** 镜像同步所需的依赖 */
export interface MirrorSyncOptions {
	/** 已登录的 MediaWiki API 实例 */
	api: MediaWikiApi;
	/** 镜像库实例 */
	mirror: SiteMirror;
	/** 同步覆盖的命名空间编号列表（增量模式会删除不在这些命名空间的过期页面） */
	namespaces: number[];
	/** 相邻 API 请求的间隔毫秒数 */
	requestInterval: number;
	/** 进度日志（调用方控制 verbose） */
	log: (message: string) => void;
}

/** 镜像同步结果 */
export interface MirrorSyncResult {
	/** full=首次全量；resume=断点续传；incremental=增量比对 */
	mode: 'full' | 'resume' | 'incremental';
	/** 本次写入（新增或更新）的页面数 */
	upserted: number;
	/** 本次删除的过期页面数（仅增量模式） */
	deleted: number;
}

/** 单次镜像查询请求的超时毫秒数 */
const REQUEST_TIMEOUT = 90_000;
/** 镜像查询失败的最大尝试次数 */
const MAX_ATTEMPTS = 5;
/** 单批标题数量（titles 参数上限，bot 可达 500） */
const TITLE_BATCH = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给请求加超时。
 * fexios 的 abortController 选项会被 deepMerge 克隆成普通对象而失效，故用 Promise.race 实现；
 * 超时后底层请求可能仍在进行，但镜像查询均为只读，重复发出无副作用。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/** 镜像库：本地 SQLite 页面镜像，供全站搜索使用（node:sqlite，需 Node ≥ 22.5） */
export class SiteMirror {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec('PRAGMA journal_mode = WAL');
		// 遇到其他进程持写锁时等待而非立即报 database is locked
		this.db.exec('PRAGMA busy_timeout = 10000');
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS pages (
				title TEXT PRIMARY KEY,
				pageid INTEGER NOT NULL,
				ns INTEGER NOT NULL,
				revid INTEGER NOT NULL,
				text TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}

	/** 页面总数 */
	getPageCount(): number {
		const row = this.db.prepare('SELECT COUNT(*) AS count FROM pages').get() as { count: number };
		return row.count;
	}

	/** 批量插入或更新页面（事务内逐行 upsert） */
	upsertPages(pages: MirrorPage[]): void {
		if (pages.length === 0) return;
		const stmt = this.db.prepare(`
			INSERT INTO pages (title, pageid, ns, revid, text) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(title) DO UPDATE SET pageid = excluded.pageid, ns = excluded.ns, revid = excluded.revid, text = excluded.text
		`);
		this.db.exec('BEGIN');
		try {
			for (const row of pages) {
				stmt.run(row.title, row.pageid, row.ns, row.revid, row.text);
			}
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	/** 批量删除页面（按标题，分批避免占位符超限），返回实际删除行数 */
	deletePages(titles: string[]): number {
		if (titles.length === 0) return 0;
		const BATCH = 500;
		let total = 0;
		this.db.exec('BEGIN');
		try {
			for (let i = 0; i < titles.length; i += BATCH) {
				const batch = titles.slice(i, i + BATCH);
				const placeholders = batch.map(() => '?').join(',');
				const info = this.db.prepare(`DELETE FROM pages WHERE title IN (${placeholders})`).run(...batch);
				total += Number(info.changes);
			}
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
		return total;
	}

	/** 所有页面的标题到 revid 映射（增量比对用，不载入正文） */
	getPageRevids(): Map<string, number> {
		const rows = this.db.prepare('SELECT title, revid FROM pages').all() as unknown as Array<{ title: string; revid: number }>;
		return new Map(rows.map((row) => [row.title, row.revid]));
	}

	/**
	 * 流式迭代全部页面记录。
	 * 按 rowid 分页惰性产出，避免把全表正文一次性载入内存；批次间让出事件循环。
	 */
	async *iteratePages(chunkSize = 2000): AsyncGenerator<MirrorPage> {
		const stmt = this.db.prepare('SELECT rowid, title, pageid, ns, revid, text FROM pages WHERE rowid > ? ORDER BY rowid LIMIT ?');
		let lastRowid = 0;
		for (;;) {
			const rows = stmt.all(lastRowid, chunkSize) as unknown as Array<MirrorPage & { rowid: number }>;
			if (rows.length === 0) return;
			for (const row of rows) {
				yield { title: row.title, pageid: row.pageid, ns: row.ns, revid: row.revid, text: row.text };
			}
			lastRowid = rows[rows.length - 1].rowid;
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	/** 读取 meta 表的键值 */
	getMeta(key: string): string | null {
		const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	/** 写入 meta 表键值；value 为 null 时删除该键 */
	setMeta(key: string, value: string | null): void {
		if (value === null) {
			this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
			return;
		}
		this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
	}

	/** 关闭数据库连接 */
	close(): void {
		this.db.close();
	}
}

/**
 * 将 API 响应中的页面合并到累积 Map。
 *
 * 同一批页面可能因源代码数超过 rvlimit 而在多个续传响应中重复出现：
 * 续传响应返回首次因 rvlimit 未含的 revisions 时需补回正文与 revid，
 * 故不能因缺少 revisions 就跳过页面，且已有页面拿到 revisions 时需更新正文。
 */
function mergePages(pageMap: Map<string, MirrorPage>, responsePages: ApiPage[]): void {
	for (const page of responsePages) {
		if (!page || page.missing) continue;
		const revision = page.revisions?.[0];
		const content = revision?.slots?.main?.content;
		const existing = pageMap.get(page.title as string);
		if (existing) {
			if (typeof content === 'string') {
				existing.text = content;
				existing.revid = revision!.revid as number;
			}
		} else {
			pageMap.set(page.title as string, {
				title: page.title as string,
				pageid: page.pageid as number,
				ns: page.ns as number,
				revid: revision?.revid ?? 0,
				text: typeof content === 'string' ? content : '',
			});
		}
	}
}

/**
 * 同步本地镜像：优先断点续传未完成的全量抓取；镜像为空时全量抓取；否则按 revid 增量比对。
 *
 * 全量使用 `generator=allpages` + 正文，按命名空间在 meta 表存 gapcontinue 断点（父子循环：
 * 外层 gapcontinue 翻批次并落库，内层 rvcontinue 取全批次源代码）。增量先拉全量 revid 清单
 * （不含正文，分钟级），与本地比对后仅补拉变更页、删除过期页。
 */
export async function syncMirror(options: MirrorSyncOptions): Promise<MirrorSyncResult> {
	const { api, mirror, namespaces, requestInterval, log } = options;

	/** 发起一次查询：超时控制 + 失败重试（镜像查询只读，重试无副作用）+ 200 响应体内 API 错误检查 */
	const query = async (params: Record<string, string | number | string[] | boolean | undefined>): Promise<MwApiResponse<ApiQueryResponse>> => {
		for (let attempt = 1; ; attempt++) {
			try {
				const { data } = await withTimeout(api.post(params), REQUEST_TIMEOUT);
				const apiError = extractApiError(data);
				if (apiError) throw new Error(`API 错误 [${apiError.code}] ${apiError.info}`);
				return data;
			} catch (error) {
				if (attempt >= MAX_ATTEMPTS) throw error;
				const delay = attempt * 2000;
				log(`  请求失败（第 ${attempt} 次）：${(error as Error).message}，${delay}ms 后重试`);
				await sleep(delay);
			}
		}
	};

	const loadProgress = (): SyncProgress => {
		const raw = mirror.getMeta('sync_progress');
		if (raw === null) return {};
		try {
			return JSON.parse(raw) as SyncProgress;
		} catch {
			return {};
		}
	};
	const saveProgress = (progress: SyncProgress): void => {
		mirror.setMeta('sync_progress', JSON.stringify(progress));
	};

	/** 全量抓取单个命名空间并写入镜像；断点存 meta 表，中断后可续传 */
	const fetchAllPages = async (ns: number, resumeGapcontinue?: string): Promise<number> => {
		const progress = loadProgress();
		let gapcontinue: string | undefined = resumeGapcontinue;
		let count = 0;
		log(`命名空间${ns}：开始${resumeGapcontinue ? '续传' : ''}全量抓取…`);
		do {
			const pageMap = new Map<string, MirrorPage>();
			let continueParams: Record<string, string | undefined> = {};
			let nextGapcontinue: string | undefined;
			do {
				const data = await query({
					action: 'query',
					generator: 'allpages',
					gapnamespace: ns,
					gaplimit: 'max',
					gapcontinue,
					prop: 'revisions',
					rvprop: ['content', 'ids'],
					rvslots: 'main',
					...continueParams,
				});
				mergePages(pageMap, data.query?.pages ?? []);
				const cont = (data.continue ?? {}) as Record<string, string>;
				if (cont.gapcontinue) nextGapcontinue = cont.gapcontinue;
				// 保留 prop 级续传参数（rvcontinue）与 continue 排序标记，仅剔除由外层循环处理的 gapcontinue；
				// rvlimit（500）远小于 gaplimit（5000），一个批次需多次 rvcontinue 才能取完全部源代码
				continueParams = {};
				for (const [key, value] of Object.entries(cont)) {
					if (key !== 'gapcontinue') continueParams[key] = value;
				}
				await sleep(requestInterval);
			} while (continueParams.rvcontinue !== undefined);
			mirror.upsertPages([...pageMap.values()]);
			count += pageMap.size;
			// 每批写入成功后保存断点，中断后可从此续传
			progress[String(ns)] = nextGapcontinue ?? true;
			saveProgress(progress);
			log(`命名空间${ns}：已获取 ${count} 个页面`);
			gapcontinue = nextGapcontinue;
		} while (gapcontinue !== undefined);
		progress[String(ns)] = true;
		saveProgress(progress);
		log(`命名空间${ns}：全量抓取完毕，共 ${count} 个页面`);
		return count;
	};

	/** 拉取单个命名空间的全量标题与 revid 清单（不含正文，仅 gapcontinue 翻页） */
	const fetchPageRevids = async (ns: number): Promise<Map<string, number>> => {
		const result = new Map<string, number>();
		let gapcontinue: string | undefined;
		do {
			const data = await query({
				action: 'query',
				generator: 'allpages',
				gapnamespace: ns,
				gaplimit: 'max',
				gapcontinue,
				prop: 'revisions',
				rvprop: 'ids',
			});
			for (const page of data.query?.pages ?? []) {
				const revid = page.revisions?.[0]?.revid;
				if (revid !== undefined) result.set(page.title as string, revid);
			}
			gapcontinue = (data.continue as Record<string, string> | undefined)?.gapcontinue;
			await sleep(requestInterval);
		} while (gapcontinue !== undefined);
		return result;
	};

	/** 对比 API revid 清单与镜像库：API 有且 revid 不同 → 待补拉；本地有而 API 无 → 待删除 */
	const reconcileRevids = (apiRevids: Map<string, number>, dbRevids: Map<string, number>): { titlesToFetch: Set<string>; titlesToDelete: Set<string> } => {
		const titlesToFetch = new Set<string>();
		const titlesToDelete = new Set<string>();
		for (const [title, apiRevid] of apiRevids) {
			if (dbRevids.get(title) !== apiRevid) titlesToFetch.add(title);
		}
		for (const title of dbRevids.keys()) {
			if (!apiRevids.has(title)) titlesToDelete.add(title);
		}
		return { titlesToFetch, titlesToDelete };
	};

	/** 按标题批量补拉正文并写入镜像（跳过已移出跟踪命名空间的页面，这类页面由删除步骤清理） */
	const fetchPagesByTitles = async (titles: Set<string>): Promise<number> => {
		if (titles.size === 0) return 0;
		const titleList = [...titles];
		const tracked = new Set(namespaces);
		let count = 0;
		for (let i = 0; i < titleList.length; i += TITLE_BATCH) {
			const batch = titleList.slice(i, i + TITLE_BATCH);
			const pageMap = new Map<string, MirrorPage>();
			let continueParams: Record<string, string | undefined> = {};
			do {
				const data = await query({
					action: 'query',
					prop: 'revisions',
					titles: batch,
					rvprop: ['content', 'ids'],
					rvslots: 'main',
					...continueParams,
				});
				mergePages(pageMap, data.query?.pages ?? []);
				continueParams = (data.continue ?? {}) as Record<string, string | undefined>;
				await sleep(requestInterval);
			} while (continueParams.rvcontinue !== undefined);
			const pages = [...pageMap.values()].filter((page) => tracked.has(page.ns));
			mirror.upsertPages(pages);
			count += pages.length;
			log(`补拉进度：${Math.min(i + TITLE_BATCH, titleList.length)}/${titleList.length}`);
		}
		return count;
	};

	/** 增量同步：revid 清单比对 → 补拉变更页 → 删除过期页（删除放在补拉后，中断时不会误删未补拉页） */
	const syncIncremental = async (): Promise<{ upserted: number; deleted: number }> => {
		log('开始增量同步（拉取全量 revid 清单比对）…');
		const apiRevids = new Map<string, number>();
		for (const ns of namespaces) {
			const revids = await fetchPageRevids(ns);
			for (const [title, revid] of revids) apiRevids.set(title, revid);
			log(`命名空间${ns}：清单 ${revids.size} 个页面`);
		}
		const { titlesToFetch, titlesToDelete } = reconcileRevids(apiRevids, mirror.getPageRevids());
		log(`比对完毕：待补拉 ${titlesToFetch.size} 个，待删除 ${titlesToDelete.size} 个`);
		const upserted = await fetchPagesByTitles(titlesToFetch);
		const deleted = mirror.deletePages([...titlesToDelete]);
		return { upserted, deleted };
	};

	const progress = loadProgress();
	const pending = namespaces.filter((ns) => typeof progress[String(ns)] === 'string');
	if (pending.length > 0) {
		log('检测到未完成的全量同步断点，从断点续传');
		let upserted = 0;
		for (const ns of namespaces) {
			const state = progress[String(ns)];
			// 无记录的命名空间视为尚未开始（上次中断在它之前），需从头抓取
			if (typeof state === 'string') upserted += await fetchAllPages(ns, state);
			else if (state !== true) upserted += await fetchAllPages(ns);
		}
		return { mode: 'resume', upserted, deleted: 0 };
	}
	if (mirror.getPageCount() === 0) {
		log('本地镜像为空，开始首次全量同步');
		let upserted = 0;
		for (const ns of namespaces) upserted += await fetchAllPages(ns);
		return { mode: 'full', upserted, deleted: 0 };
	}
	const { upserted, deleted } = await syncIncremental();
	return { mode: 'incremental', upserted, deleted };
}
