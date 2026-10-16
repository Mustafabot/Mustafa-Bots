import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MwApiParams } from 'wiki-saikou';
import { createZhApi } from '../utils/createApi.js';
import { checkModerationQueued, checkModerationQueuedError, extractApiError } from '../utils/retry.js';
import clientlogin from '../clientlogin.js';
import config from '../config.js';

const PAGE_PREFIX = 'User:没有羽翼的格雷塔/BotConfig/';

export interface RulesetDraft {
	name: string;
	baseRevid: number | null;
	content: string;
	updatedAt: number;
}

export interface RulesetSummary {
	name: string;
	pageTitle: string;
	draftUpdatedAt: number | null;
}

/** 规则集名必须能安全地当文件名，且不能逃出草稿目录 */
export function safeName(name: string): string {
	// ':' 必须挡掉：Windows 上 `C:evil` 是驱动器相对路径，
	// resolve 后会落到进程工作目录而不是草稿目录
	if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes(':')) {
		throw new Error(`规则集名 "${name}" 非法：不能为空，且不能包含斜杠、冒号或 ..`);
	}
	return name;
}

export function pageTitleFor(name: string): string {
	return `${PAGE_PREFIX}${safeName(name)}`;
}

export class RulesetStore {
	private readonly dir: string;

	constructor(draftDir: string) {
		this.dir = resolve(draftDir);
		mkdirSync(this.dir, { recursive: true });
	}

	private fileFor(name: string): string {
		return resolve(this.dir, `${safeName(name)}.json`);
	}

	list(): RulesetSummary[] {
		return readdirSync(this.dir)
			.filter((file) => file.endsWith('.json'))
			.map((file): RulesetSummary | null => {
				const name = file.slice(0, -'.json'.length);
				try {
					const draft = this.read(name);
					return draft ? { name, pageTitle: pageTitleFor(name), draftUpdatedAt: draft.updatedAt } : null;
				} catch {
					// 名字非法或文件损坏：跳过这一条，不要让一个野文件搞崩整个列表
					return null;
				}
			})
			.filter((item): item is RulesetSummary => item !== null)
			.sort((a, b) => (b.draftUpdatedAt ?? 0) - (a.draftUpdatedAt ?? 0));
	}

	read(name: string): RulesetDraft | null {
		const file = this.fileFor(name);
		if (!existsSync(file)) return null;
		try {
			return JSON.parse(readFileSync(file, 'utf-8')) as RulesetDraft;
		} catch {
			return null;
		}
	}

	write(name: string, content: string, baseRevid: number | null): RulesetDraft {
		const safe = safeName(name);
		const draft: RulesetDraft = { name: safe, baseRevid, content, updatedAt: Date.now() };
		writeFileSync(this.fileFor(safe), JSON.stringify(draft, null, 2), 'utf-8');
		return draft;
	}

	remove(name: string): boolean {
		const file = this.fileFor(name);
		if (!existsSync(file)) return false;
		rmSync(file);
		return true;
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

export type RulesetApiFactory = () => Promise<RulesetApi>;

/** 默认工厂：真实登录；exitOnFailure=false 时登录失败抛错而非退出进程，由路由层 .catch 降级成 500，不打挂 GUI 服务 */
async function defaultRulesetApi(): Promise<RulesetApi> {
	const api = createZhApi();
	await clientlogin(api, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!, config.zh.api, false);
	return api;
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

	async fetchRemote(name: string): Promise<{ content: string | null; revid: number | null }> {
		const api = await this.createApi();
		const { data } = await api.post<any>({
			action: 'query',
			format: 'json',
			formatversion: '2',
			prop: 'revisions',
			rvprop: ['content', 'ids'],
			rvslots: 'main',
			titles: pageTitleFor(name),
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

	async publish(name: string): Promise<
		{ ok: true; revid: number | null } | { ok: false; reason: 'conflict' | 'missing'; remote: string | null; remoteRevid: number | null }
	> {
		const draft = this.store.read(name);
		if (!draft) throw new Error(`规则集 "${name}" 没有本地草稿`);
		const remote = await this.fetchRemote(name);
		// 首次发布（线上还不存在）时 baseRevid 必须是 null；此后每次发布都要求 revid 与草稿记录的一致
		if (remote.revid !== draft.baseRevid) {
			return { ok: false, reason: remote.revid === null ? 'missing' : 'conflict', remote: remote.content, remoteRevid: remote.revid };
		}
		const api = await this.createApi();
		let data: unknown = null;
		let thrown: Error | null = null;
		try {
			({ data } = await api.postWithEditToken<unknown>({
				action: 'edit',
				format: 'json',
				formatversion: '2',
				title: pageTitleFor(name),
				text: draft.content,
				summary: `机器人：更新规则集 ${name}`,
				watchlist: 'nochange',
				...(remote.revid === null ? { createonly: 1 } : { baserevid: remote.revid }),
			}));
		} catch (error) {
			thrown = error as Error;
		}
		// moderation-*-queued 计为成功（项目全局约定）：已入队，但没有新 revid 可记录
		if (thrown && checkModerationQueuedError(thrown)) return { ok: true, revid: null };
		if (checkModerationQueued(data)) return { ok: true, revid: null };
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
		this.store.write(name, draft.content, newRevid);
		return { ok: true, revid: newRevid };
	}
}
