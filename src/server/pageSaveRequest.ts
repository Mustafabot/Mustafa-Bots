/**
 * 页面保存请求的校验（`PUT /api/link-config`）。
 *
 * 与还原队列的 `queueRequest` 分开：那边收发的是条目数组，这里收发的是整页正文。
 * 两者都只做"形状与类型"的校验，业务语义留给写回单元。
 */
export interface PageSaveRequest {
	page: string;
	content: string;
	baseRevid: number | null;
	force: boolean;
}

/** 校验并归一请求体；不合法时抛错，信息面向调用方 */
export function parsePageSaveRequest(body: unknown): PageSaveRequest {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是一个对象');
	const raw = body as Record<string, unknown>;
	if (typeof raw.page !== 'string' || raw.page.trim() === '') throw new Error('page 必须是非空字符串');
	// 标题会被拼进请求与日志，不允许换行与控制字符
	// eslint-disable-next-line no-control-regex -- 这里就是要匹配控制字符，属于本意
	if (/[\u0000-\u001f]/.test(raw.page)) throw new Error('page 不能包含换行或控制字符');
	if (typeof raw.content !== 'string') throw new Error('content 必须是字符串');
	if (raw.baseRevid !== null && typeof raw.baseRevid !== 'number') throw new Error('baseRevid 必须是数字或 null');
	if (raw.force !== undefined && typeof raw.force !== 'boolean') throw new Error('force 必须是布尔值');
	return {
		page: raw.page.trim(),
		content: raw.content,
		baseRevid: raw.baseRevid as number | null,
		force: raw.force === true,
	};
}
