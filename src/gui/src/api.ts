// 前端接口封装：把一期冻结的 HTTP 接口包成带类型的函数。
// 统一同源带 cookie、统一把非 2xx 转成 ApiError——调用方只管拿数据、认状态码。
// Vite/Bundler 解析，import 不带 .js 后缀。
import type {
	HistoryDiffResult,
	HistoryTaskDetail,
	HistoryTaskRow,
	NamespaceList,
	PublishOptions,
	PublishSuccess,
	RulesetDraft,
	RulesetRemote,
	RulesetSummary,
	ScanDiffResult,
	ScanPageSlice,
	ScanResultMeta,
	StartTaskBody,
	TaskDescriptor,
	TaskRecord,
	UploadTaskDraft,
	UploadTaskSummary,
} from './types';

/**
 * 失败响应体里可能带的字段：diff 接口的 `reason`、发布冲突的远端信息（remote / remoteRevid）等。
 * `reason` 是 diff 接口的 `'missing' | 'unchanged' | 'error'` 与发布的 `'conflict' | 'missing'` 的并集，
 * 消费方据它区分"内容相同"与真错误。其余字段经索引签名兜底。
 */
export interface ApiErrorBody {
	error?: string;
	reason?: 'missing' | 'unchanged' | 'error' | 'conflict';
	[key: string]: unknown;
}

/**
 * 接口错误：携带 HTTP 状态码、服务端错误信息与解析后的响应体。
 * 调用方按 `status` 判定（如 401 触发登录门）；`body` 取服务端附带的业务信息——
 * 两个 diff 接口的 `reason`（区分"内容相同"与真错误）、发布接口的冲突版本号。
 */
export class ApiError extends Error {
	readonly status: number;
	readonly body: ApiErrorBody | null;
	constructor(status: number, message: string, body: ApiErrorBody | null = null) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.body = body;
	}
}

/** 解析响应文本为 JSON；空体或非 JSON 时返回 null（204、静态回退页等会走到这里） */
function parseBody(text: string): unknown {
	if (text === '') return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * 统一请求助手：同源带 gui_session cookie，解析 JSON 响应，非 2xx 抛 ApiError。
 * 先读 text 再手动 parse，而非直接 res.json()——响应体可能为空或不是 JSON。
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, { credentials: 'same-origin', ...init });
	const body = parseBody(await res.text());
	if (!res.ok) {
		const message = (body as ApiErrorBody | null)?.error ?? `请求失败（${res.status}）`;
		throw new ApiError(res.status, message, body as ApiErrorBody | null);
	}
	return body as T;
}

/** JSON 请求体的 init，POST 与 PUT 共用 */
function jsonInit(method: 'POST' | 'PUT', data?: unknown): RequestInit {
	return {
		method,
		headers: { 'content-type': 'application/json' },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	};
}

/** 把字符串编码进 URL 段或查询值，避免标题里的斜杠、空格、中文破坏路径 */
function seg(value: string): string {
	return encodeURIComponent(value);
}

/** 全部接口方法；失败一律抛 ApiError */
export const api = {
	login: (password: string) => request<{ ok: boolean }>('/api/auth/login', jsonInit('POST', { password })),
	descriptors: () => request<{ descriptors: TaskDescriptor[] }>('/api/descriptors'),
	task: {
		get: () => request<{ task: TaskRecord | null }>('/api/task'),
		start: (body: StartTaskBody) => request<{ task: TaskRecord }>('/api/task', jsonInit('POST', body)),
		abort: () => request<{ ok: boolean }>('/api/task/abort', jsonInit('POST')),
	},
	namespaces: (wiki: 'zh' | 'cm') => request<NamespaceList>(`/api/namespaces?wiki=${seg(wiki)}`),
	scans: {
		list: () => request<{ scans: ScanResultMeta[] }>('/api/scans'),
		page: (name: string, offset: number, limit: number) => request<ScanPageSlice>(`/api/scans/${seg(name)}?offset=${offset}&limit=${limit}`),
		diff: (name: string, page: string) => request<ScanDiffResult>(`/api/scans/${seg(name)}/diff?page=${seg(page)}`),
	},
	history: {
		list: () => request<{ tasks: HistoryTaskRow[] }>('/api/history'),
		detail: (id: string) => request<HistoryTaskDetail>(`/api/history/${seg(id)}`),
		diff: (id: string, page: string) => request<HistoryDiffResult>(`/api/history/${seg(id)}/diff?page=${seg(page)}`),
	},
	rulesets: {
		list: () => request<{ rulesets: RulesetSummary[] }>('/api/rulesets'),
		/** `page` 指定要看哪一页的线上内容，缺省看草稿记的目标页 */
		read: (name: string, page?: string) =>
			request<{ draft: RulesetDraft | null; remote: RulesetRemote }>(`/api/rulesets/${seg(name)}${page === undefined || page.trim() === '' ? '' : `?page=${seg(page.trim())}`}`),
		/** `page` 指定目标配置页；缺省沿用草稿记的页 */
		save: (name: string, content: string, page?: string) =>
			request<{ draft: RulesetDraft }>(`/api/rulesets/${seg(name)}`, jsonInit('PUT', { content, ...(page === undefined ? {} : { page }) })),
		publish: (name: string, options: PublishOptions = {}) => request<PublishSuccess>(`/api/rulesets/${seg(name)}/publish`, jsonInit('POST', options)),
	},
	uploads: {
		/**
		 * 上传一个本机文件：请求体就是文件原始字节，服务端存进 data/gui/uploads/。
		 * 回参里 `name` 只是文件名，`path` 是仓库相对路径（`data/gui/uploads/<name>`）——
		 * 配置里要填的是 `path`：脚本以仓库根为工作目录解析它，填 `name` 会判成文件不存在。
		 */
		put: (file: File) => request<{ name: string; size: number; path: string }>(`/api/uploads?name=${seg(file.name)}`, { method: 'POST', body: file }),
		/** 列出现有的暂存文件与总大小，供清理前告知用户将删掉多少 */
		list: () => request<{ files: Array<{ name: string; size: number }>; total: number }>('/api/uploads'),
		/** 本机文件的预览地址，直接给 <img src> */
		previewUrl: (name: string) => `/api/uploads/${seg(name)}`,
		clear: () => request<{ removed: number }>('/api/uploads', { method: 'DELETE' }),
	},
	uploadTasks: {
		list: () => request<{ tasks: UploadTaskSummary[] }>('/api/upload-tasks'),
		read: (name: string) => request<{ task: UploadTaskDraft | null }>(`/api/upload-tasks/${seg(name)}`),
		save: (name: string, content: string) => request<{ task: UploadTaskDraft }>(`/api/upload-tasks/${seg(name)}`, jsonInit('PUT', { content })),
		remove: (name: string) => request<{ ok: boolean }>(`/api/upload-tasks/${seg(name)}`, { method: 'DELETE' }),
	},
	/** 共享站的分类前缀搜索，供分类输入补全 */
	categories: (prefix: string) => request<{ categories: string[] }>(`/api/categories?prefix=${seg(prefix)}`),
};
