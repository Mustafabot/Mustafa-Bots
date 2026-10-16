/**
 * 取页面正文并算 diff。
 *
 * 历史库只存新旧 revid、扫描结果只存命中所在行，正文一律现取——
 * 这样数据库不会膨胀，而"看 diff"永远反映的是线上真实内容。
 */
import type { MwApiParams } from 'wiki-saikou';
import { getSession } from './session.js';
import { diffLines, summarizeDiff, type DiffLine, type DiffStats } from '../core/pageDiff.js';
import { prepareRule, type ReplaceRule } from '../replace/replaceRules.js';

export type WikiName = 'zh' | 'cm';

export interface PageTextApi {
	post<T>(params: MwApiParams): Promise<{ data: T }>;
}

export type PageTextApiFactory = (wiki: WikiName) => Promise<PageTextApi>;

export type DiffOutcome =
	| { ok: true; lines: DiffLine[]; stats: DiffStats; oldRevid: number | null; newRevid: number | null }
	| { ok: false; reason: 'missing' | 'unchanged' | 'error'; message: string };

export type RuleDiffOutcome = { ok: true; lines: DiffLine[]; stats: DiffStats } | { ok: false; reason: 'missing' | 'unchanged' | 'error'; message: string };

interface ApiRevision {
	revid?: number;
	slots?: { main?: { content?: string } };
}

interface ApiPage {
	title?: string;
	missing?: boolean;
	revisions?: ApiRevision[];
}

async function defaultPageTextApi(wiki: WikiName): Promise<PageTextApi> {
	// 复用共享登录会话：多个 diff 请求共享同一份已登录 api，不再每次取正文都登录一遍。
	// 登录失败会抛错（exitOnFailure=false），由调用的 try/catch 降级成 error 结果，不打挂 GUI 服务。
	return getSession(wiki);
}

export class PageTextService {
	private readonly createApi: PageTextApiFactory;

	constructor(createApi: PageTextApiFactory = defaultPageTextApi) {
		this.createApi = createApi;
	}

	/**
	 * 取某页正文；revid 省略时取最新修订（萌百不接受 rvstartid=-1 这种"取最新"写法，必须省略该参数）。
	 * 页面不存在或版本取不到返回 null。api 由调用方建好复用，避免一次操作重复登录。
	 */
	async fetchRevision(api: PageTextApi, title: string, revid?: number): Promise<string | null> {
		const { data } = await api.post<{ query?: { pages?: ApiPage[] } }>({
			action: 'query',
			format: 'json',
			formatversion: '2',
			prop: 'revisions',
			titles: title,
			...(revid === undefined ? {} : { rvstartid: revid }),
			rvlimit: '1',
			rvprop: 'content|ids',
			rvslots: 'main',
		} as MwApiParams);
		const page = data?.query?.pages?.[0];
		if (!page || page.missing) return null;
		const revision = page.revisions?.[0];
		return revision?.slots?.main?.content ?? null;
	}

	/** 按新旧两个修订版本算 diff */
	async diffByRevid(wiki: WikiName, title: string, oldRevid: number, newRevid: number): Promise<DiffOutcome> {
		try {
			const api = await this.createApi(wiki);
			const [oldText, newText] = await Promise.all([this.fetchRevision(api, title, oldRevid), this.fetchRevision(api, title, newRevid)]);
			if (oldText === null || newText === null) return { ok: false, reason: 'missing', message: `页面 "${title}" 不存在或版本取不到` };
			if (oldText === newText) return { ok: false, reason: 'unchanged', message: `页面 "${title}" 两个版本内容相同，看不出差异` };
			const lines = diffLines(oldText, newText);
			return { ok: true, lines, stats: summarizeDiff(lines), oldRevid, newRevid };
		} catch (error) {
			return { ok: false, reason: 'error', message: (error as Error).message };
		}
	}

	/** 取页面最新正文，按规则算出改后文本再 diff——扫描结果的"整段改动"用它 */
	async diffByRules(wiki: WikiName, title: string, rules: ReplaceRule[]): Promise<RuleDiffOutcome> {
		try {
			const api = await this.createApi(wiki);
			const current = await this.fetchRevision(api, title);
			if (current === null) return { ok: false, reason: 'missing', message: `页面 "${title}" 不存在` };
			let next = current;
			for (const rule of rules) {
				const prepared = prepareRule(rule);
				next = prepared.apply(next).text;
			}
			if (next === current) return { ok: false, reason: 'unchanged', message: `页面 "${title}" 按当前规则已无匹配` };
			const lines = diffLines(current, next);
			return { ok: true, lines, stats: summarizeDiff(lines) };
		} catch (error) {
			return { ok: false, reason: 'error', message: (error as Error).message };
		}
	}
}
