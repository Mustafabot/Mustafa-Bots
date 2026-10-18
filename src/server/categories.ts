/**
 * 共享站分类的前缀搜索，供上传页的分类输入做自动补全。
 *
 * 这是公开的只读查询，但仍复用共享登录会话：一处登录、多处置用，
 * 也让服务端的出站请求都带同一个 User-Agent。
 */
import type { MwApiParams } from 'wiki-saikou';
import { getSession } from './session.js';

/** 只声明真正用到的方法，好让测试注入 stub；真实 MediaWikiApi 结构性兼容它 */
export interface CategoryApi {
	post<T>(params: MwApiParams): Promise<{ data: T }>;
}

export type CategoryApiFactory = () => Promise<CategoryApi>;

async function defaultApi(): Promise<CategoryApi> {
	return getSession('cm');
}

/** 一次返回的候选数量 */
const LIMIT = 10;

export class CategoryService {
	private readonly createApi: CategoryApiFactory;
	/** 前缀 → 候选；分类列表变动不快，进程内缓存足够 */
	private readonly cache = new Map<string, string[]>();

	constructor(createApi: CategoryApiFactory = defaultApi) {
		this.createApi = createApi;
	}

	async search(prefix: string): Promise<string[]> {
		const trimmed = prefix.trim();
		if (trimmed === '') return [];
		const cached = this.cache.get(trimmed);
		if (cached !== undefined) return cached;

		const api = await this.createApi();
		const { data } = await api.post<{ query?: { allcategories?: Array<Record<string, string> | string> } }>({
			action: 'query',
			format: 'json',
			formatversion: '2',
			list: 'allcategories',
			acprefix: trimmed,
			aclimit: LIMIT,
		});
		// formatversion=2 下每条是 { category: '…' }；老写法（及测试桩）是 { '*': '…' }，两种都认
		const categories = (data.query?.allcategories ?? [])
			.map((item) => (typeof item === 'string' ? item : (item.category ?? item['*'] ?? '')))
			.filter((name) => name !== '');
		this.cache.set(trimmed, categories);
		return categories;
	}
}
