import type { MwApiParams } from 'wiki-saikou';
import { checkModerationQueued, checkModerationQueuedError, extractApiError } from '../utils/retry.js';
import { DraftStore, safeDraftName } from './drafts.js';
import { getSession } from './session.js';

const PAGE_PREFIX = 'User:没有羽翼的格雷塔/BotConfig/';

export interface RulesetDraft {
	name: string;
	/** 发布目标页；草稿记着它，好让发布冲突检测知道基线是哪一页的 */
	page: string;
	baseRevid: number | null;
	content: string;
	updatedAt: number;
}

export interface RulesetSummary {
	name: string;
	pageTitle: string;
	draftUpdatedAt: number | null;
}

/** 规则集名与通用草稿名同一套规则；保留旧名以免调用方到处改 */
export const safeName = safeDraftName;

export function pageTitleFor(name: string): string {
	return `${PAGE_PREFIX}${safeName(name)}`;
}

/**
 * 存草稿时该记的基线：目标页没变才沿用旧基线，换页就作废。
 *
 * 基线是"某一页当时的版本号"，照抄到另一页去等于拿旧页的 revid 冒充新页的基线，冲突检测形同虚设。
 */
export function draftBaseline(previous: { page: string; baseRevid: number | null } | null, page?: string): number | null {
	if (previous === null) return null;
	const target = typeof page === 'string' && page.trim() !== '' ? page.trim() : previous.page;
	return target === previous.page ? previous.baseRevid : null;
}

export class RulesetStore {
	private readonly drafts: DraftStore;

	constructor(draftDir: string) {
		this.drafts = new DraftStore(draftDir);
	}

	list(): RulesetSummary[] {
		return this.drafts
			.listFiles()
			.map((name): RulesetSummary | null => {
				try {
					const draft = this.read(name);
					return draft ? { name, pageTitle: draft.page, draftUpdatedAt: draft.updatedAt } : null;
				} catch {
					// 名字非法：跳过这一条，不要让一个野文件搞崩整个列表
					return null;
				}
			})
			.filter((item): item is RulesetSummary => item !== null)
			.sort((a, b) => (b.draftUpdatedAt ?? 0) - (a.draftUpdatedAt ?? 0));
	}

	read(name: string): RulesetDraft | null {
		const raw = this.drafts.readRaw(name);
		if (raw === null) return null;
		const baseRevid = typeof raw.baseRevid === 'number' ? raw.baseRevid : null;
		// 早期草稿没有 page 字段，补上默认目标页，免得调用方到处判缺
		const page = typeof raw.page === 'string' && raw.page !== '' ? raw.page : pageTitleFor(name);
		const content = typeof raw.content === 'string' ? raw.content : '';
		const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
		return { name, page, baseRevid, content, updatedAt };
	}

	/**
	 * 存草稿。baseRevid 必须是 page 这个页面的版本号；换了页就不能把旧页的基线带过去，
	 * 先前的基线要由 draftBaseline(draft, page) 依新页作废。
	 */
	write(name: string, content: string, baseRevid: number | null, page?: string): RulesetDraft {
		const safe = safeName(name);
		const previous = this.read(safe);
		const target = typeof page === 'string' && page.trim() !== '' ? page.trim() : (previous?.page ?? pageTitleFor(safe));
		const draft: RulesetDraft = { name: safe, page: target, baseRevid, content, updatedAt: Date.now() };
		this.drafts.writeRaw(safe, { ...draft });
		return draft;
	}

	remove(name: string): boolean {
		return this.drafts.remove(name);
	}
}

/**
 * 发布路径注入用的 api 抽象。
 * 只声明真正用到的两个方法，好让测试注入 stub；真实 MediaWikiApi 结构性兼容它。
 */
export interface RulesetApi {
	post<T>(params: MwApiParams): Promise<{ data: T }>;
	postWithEditToken<T>(params: MwApiParams): Promise<{ data: T }>;
}

/** 发布的可选项 */
export interface PublishOptions {
	/** 目标配置页标题；缺省用草稿记录的页 */
	page?: string;
	/** 以线上当前版本为基线强行覆盖（冲突后比对过线上内容再发） */
	force?: boolean;
}

export type RulesetApiFactory = () => Promise<RulesetApi>;

/** 跑任务用的规则集来源：内容直传优先，其次才是本地草稿 */
export interface RunRuleset {
	/** 标签：进历史库，只用于人看 */
	name: string;
	/** 规则集 JSON 原文 */
	content: string;
}

/**
 * 决定一次任务用哪份规则。
 *
 * 服务端拿到内容后写临时文件喂 `--config-file`，所以跑任务并不需要预设名——
 * 界面上改完规则直接扫描/提交即可，起名存草稿只为复用与发布。故内容直传优先于草稿，
 * 仅同步镜像（--sync-only）则两者都可以没有。名字在这里只当历史标签，缺省记「未命名规则」。
 */
export function resolveRunRuleset(
	store: { read(name: string): { content: string } | null },
	input: { rulesetName?: string; rulesetContent?: string; syncOnly?: boolean },
): RunRuleset | null {
	const name = typeof input.rulesetName === 'string' ? input.rulesetName.trim() : '';
	const content = typeof input.rulesetContent === 'string' ? input.rulesetContent.trim() : '';
	if (content !== '') {
		return { name: name === '' ? '未命名规则' : name, content };
	}
	if (name !== '') {
		const draft = store.read(name);
		if (!draft) throw new Error(`规则集 "${name}" 没有本地草稿`);
		return { name, content: draft.content };
	}
	if (input.syncOnly === true) return null;
	throw new Error('该任务必须先提供规则内容（或先保存规则集）');
}

/** 默认工厂：复用共享登录会话；登录失败抛错而非退出进程，由路由层 .catch 降级成 500，不打挂 GUI 服务 */
async function defaultRulesetApi(): Promise<RulesetApi> {
	return getSession('zh');
}

/**
 * 发布：把草稿写回 wiki 配置页，带 baserevid 冲突检测。
 *
 * 第二个参数供测试注入 stub；默认走真实登录，调用方无需传。
 */
export class RulesetPublisher {
	private readonly store: RulesetStore;
	private readonly createApi: RulesetApiFactory;

	constructor(store: RulesetStore, createApi: RulesetApiFactory = defaultRulesetApi) {
		this.store = store;
		this.createApi = createApi;
	}

	/** 取线上某一页的当前内容与 revid；页面不存在时两者都是 null */
	async fetchRemote(pageTitle: string): Promise<{ content: string | null; revid: number | null }> {
		const api = await this.createApi();
		const { data } = await api.post<any>({
			action: 'query',
			format: 'json',
			formatversion: '2',
			prop: 'revisions',
			rvprop: ['content', 'ids'],
			rvslots: 'main',
			titles: pageTitle,
		});
		const page = data?.query?.pages?.[0];
		if (!page || page.missing) return { content: null, revid: null };
		const revision = page.revisions?.[0];
		const content = revision?.slots?.main?.content;
		return {
			content: typeof content === 'string' ? content : null,
			revid: typeof revision?.revid === 'number' ? revision.revid : null,
		};
	}

	async publish(name: string, options: PublishOptions = {}): Promise<
		{ ok: true; revid: number | null } | { ok: false; reason: 'conflict' | 'missing'; remote: string | null; remoteRevid: number | null }
	> {
		const draft = this.store.read(name);
		if (!draft) throw new Error(`规则集 "${name}" 没有本地草稿`);
		const page = typeof options.page === 'string' && options.page.trim() !== '' ? options.page.trim() : draft.page;
		const remote = await this.fetchRemote(page);
		// 基线从属于草稿记录的那个页面：临时发到别的页时，旧页的 revid 不能拿来当基线
		const baseline = page === draft.page ? draft.baseRevid : null;
		// 首次发布（线上还不存在）时基线必须是 null；此后每次发布都要求 revid 与草稿记录的一致
		if (options.force !== true && remote.revid !== baseline) {
			return { ok: false, reason: remote.revid === null ? 'missing' : 'conflict', remote: remote.content, remoteRevid: remote.revid };
		}
		// 指定 force 即"已比对过线上内容，仍要覆盖"：以线上当前版本为基线发出去
		const baseRevid = options.force === true ? remote.revid : baseline;
		const api = await this.createApi();
		let data: unknown = null;
		let thrown: Error | null = null;
		try {
			({ data } = await api.postWithEditToken<unknown>({
				action: 'edit',
				format: 'json',
				formatversion: '2',
				title: page,
				text: draft.content,
				summary: `机器人：更新规则集 ${name}`,
				watchlist: 'nochange',
				...(baseRevid === null ? { createonly: 1 } : { baserevid: baseRevid }),
			}));
		} catch (error) {
			thrown = error as Error;
		}
		// moderation-*-queued 计为成功（项目全局约定）：已入队，但没有新 revid 可记录
		if (thrown && checkModerationQueuedError(thrown)) {
			this.store.write(name, draft.content, draftBaseline(draft, page), page);
			return { ok: true, revid: null };
		}
		if (checkModerationQueued(data)) {
			this.store.write(name, draft.content, draftBaseline(draft, page), page);
			return { ok: true, revid: null };
		}
		if (thrown) throw thrown;
		// createZhApi() 没有设 throwOnApiError，wiki-saikou 默认也不抛，
		// 因此 API 层错误会出现在响应体里而不是异常里——必须显式判定。
		// 漏判的后果是把失败的编辑当成成功，并把 baseRevid 写成 null 污染后续冲突检测。
		const apiError = extractApiError(data);
		if (apiError) {
			// 页面已被他人创建：这正是冲突，按冲突返回而不是抛错
			if (apiError.code === 'articleexists') {
				return { ok: false, reason: 'conflict', remote: null, remoteRevid: null };
			}
			throw new Error(`[${apiError.code}] ${apiError.info}`);
		}
		const edit = (data as { edit?: { result?: string; newrevid?: number } } | null)?.edit;
		if (edit?.result !== 'Success') {
			throw new Error(`编辑响应异常: ${JSON.stringify(data)}`);
		}
		const newRevid = typeof edit.newrevid === 'number' ? edit.newrevid : null;
		this.store.write(name, draft.content, newRevid, page);
		return { ok: true, revid: newRevid };
	}
}
