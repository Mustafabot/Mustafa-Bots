/**
 * 带版本冲突检测的页面写回。
 *
 * 规则集发布、还原队列的保存都用它：基线从属于目标页，线上不存在时用 createonly，
 * 入队计为成功，`articleexists` 视为冲突。写回线上页面的语义只在这里定义一次。
 */
import type { MwApiParams } from 'wiki-saikou';
import { checkModerationQueued, checkModerationQueuedError, extractApiError } from '../utils/retry.js';

export interface PageWriteApi {
	post<T>(params: MwApiParams): Promise<{ data: T }>;
	postWithEditToken<T>(params: MwApiParams): Promise<{ data: T }>;
}

export type PageReadResult = { content: string | null; revid: number | null };

export type PageWriteResult =
	| { ok: true; revid: number | null }
	| { ok: false; reason: 'conflict' | 'missing'; remote: string | null; remoteRevid: number | null };

/** 取线上某一页的当前内容与 revid；页面不存在时两者都是 null */
export async function readPage(api: PageWriteApi, title: string): Promise<PageReadResult> {
	const { data } = await api.post<any>({
		action: 'query',
		format: 'json',
		formatversion: '2',
		prop: 'revisions',
		rvprop: ['content', 'ids'],
		rvslots: 'main',
		titles: title,
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

/**
 * 写回一页。
 * `force` 表示"已比对过线上内容，仍要覆盖"：跳过基线检查，以线上当前版本为基线。
 */
export async function writePage(
	api: PageWriteApi,
	options: { title: string; text: string; baseRevid: number | null; force?: boolean; summary: string },
): Promise<PageWriteResult> {
	const remote = await readPage(api, options.title);
	if (options.force !== true && remote.revid !== options.baseRevid) {
		return { ok: false, reason: remote.revid === null ? 'missing' : 'conflict', remote: remote.content, remoteRevid: remote.revid };
	}
	const baseRevid = options.force === true ? remote.revid : options.baseRevid;

	let data: unknown = null;
	let thrown: Error | null = null;
	try {
		({ data } = await api.postWithEditToken<unknown>({
			action: 'edit',
			format: 'json',
			formatversion: '2',
			title: options.title,
			text: options.text,
			summary: options.summary,
			watchlist: 'nochange',
			...(baseRevid === null ? { createonly: 1 } : { baserevid: baseRevid }),
		}));
	} catch (error) {
		thrown = error as Error;
	}
	// moderation-*-queued 计为成功（项目全局约定）：已入队，但没有新 revid
	if (thrown && checkModerationQueuedError(thrown)) return { ok: true, revid: null };
	if (checkModerationQueued(data)) return { ok: true, revid: null };
	if (thrown) throw thrown;

	// wiki-saikou 默认不抛 API 层错误，必须显式判定，否则会把失败当成功
	const apiError = extractApiError(data);
	if (apiError) {
		// 页面已被他人创建：这正是冲突
		if (apiError.code === 'articleexists') return { ok: false, reason: 'conflict', remote: null, remoteRevid: null };
		throw new Error(`[${apiError.code}] ${apiError.info}`);
	}
	const edit = (data as { edit?: { result?: string; newrevid?: number } } | null)?.edit;
	if (edit?.result !== 'Success') throw new Error(`编辑响应异常: ${JSON.stringify(data)}`);
	return { ok: true, revid: typeof edit.newrevid === 'number' ? edit.newrevid : null };
}
