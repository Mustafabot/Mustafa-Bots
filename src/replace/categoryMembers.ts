/**
 * 分类成员展开：取分类下的直属页面（cmtype=page），不递归子分类、不把文件当页面。
 *
 * 只做只读查询，api 由调用方注入（脚本用已登录的实例，测试用桩）。
 * 输入须是 `Category:<名>` 形式的标题；targetList.ts 的 parseTargetList 负责补前缀。
 */
import type { MwApiParams } from 'wiki-saikou';

/** 只声明真正用到的方法，好让测试注入 stub；真实 MediaWikiApi 结构性兼容它 */
export interface CategoryMembersApi {
	post<T>(params: MwApiParams): Promise<{ data: T }>;
}

interface CategoryMembersResponse {
	query?: {
		categorymembers?: Array<{ title?: string }>;
	};
	continue?: {
		cmcontinue?: string;
	};
}

/** 取一个分类的全部直属页面成员；分页跟到底，结果按首次出现去重 */
export async function fetchCategoryMembers(api: CategoryMembersApi, category: string): Promise<string[]> {
	const titles: string[] = [];
	const seen = new Set<string>();
	let cmcontinue: string | undefined;
	do {
		const { data } = await api.post<CategoryMembersResponse>({
			action: 'query',
			format: 'json',
			formatversion: '2',
			list: 'categorymembers',
			cmtitle: category,
			cmtype: 'page',
			cmlimit: 'max',
			cmprop: 'title',
			...(cmcontinue === undefined ? {} : { cmcontinue }),
		});
		for (const member of data.query?.categorymembers ?? []) {
			const title = member.title?.trim();
			if (title === undefined || title === '' || seen.has(title)) continue;
			seen.add(title);
			titles.push(title);
		}
		cmcontinue = data.continue?.cmcontinue;
	} while (cmcontinue !== undefined);
	return titles;
}
