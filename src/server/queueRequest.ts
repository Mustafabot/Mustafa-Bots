/**
 * `PUT /api/restore-queue` 的请求体校验。
 * 单独成文件，好让这段纯逻辑进单测——路由层只负责取正文与回响应。
 */
import { normalizeEntry } from '../restore/queueFormat.js';

export interface QueueSaveRequest {
	entries: string[];
	baseRevid: number | null;
	force: boolean;
}

/** 校验并归一请求体；不合法时抛错，信息面向调用方 */
export function parseQueueSaveRequest(body: unknown): QueueSaveRequest {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是一个对象');
	const raw = body as Record<string, unknown>;
	if (!Array.isArray(raw.entries)) throw new Error('entries 必须是字符串数组');
	// 非字符串元素不能静默丢弃：`{entries:[123]}` 会被归一成空数组，PUT 就把队列页清空了，这里必须报错
	if (raw.entries.some((item) => typeof item !== 'string')) throw new Error('entries 的每一项都必须是字符串');
	const entries = (raw.entries as string[])
		.map((item) => item.trim())
		.filter((item) => item !== '')
		.map((item) => normalizeEntry(item));
	if (raw.baseRevid !== null && typeof raw.baseRevid !== 'number') throw new Error('baseRevid 必须是数字或 null');
	if (raw.force !== undefined && typeof raw.force !== 'boolean') throw new Error('force 必须是布尔值');
	return {
		entries: [...new Set(entries)],
		baseRevid: raw.baseRevid as number | null,
		force: raw.force === true,
	};
}
