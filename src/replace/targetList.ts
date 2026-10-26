/**
 * 页面/分类清单解析：一行一个，分类行以 `分类:` / `Category:` / `Cat:` 开头
 * （大小写与全角冒号都认）。分类统一写成 `Category:<名>`，供 categorymembers 查询使用。
 *
 * 解析只做文本拆分，不访问网络；分类展开在 categoryMembers.ts。
 */
export interface TargetList {
	/** 明确的页面标题，按输入顺序去重 */
	pages: string[];
	/** 分类标题（已补 `Category:` 前缀），按输入顺序去重 */
	categories: string[];
}

/** 分类行：前缀 + 半角/全角冒号，冒号前后允许空白 */
const CATEGORY_LINE = /^(?:分类|category|cat)\s*[:：]\s*(.*)$/iu;

/** 把清单文本拆成页面与分类两组，空行与空分类名忽略 */
export function parseTargetList(text: string): TargetList {
	const pages: string[] = [];
	const categories: string[] = [];
	const pageSeen = new Set<string>();
	const categorySeen = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '') continue;
		const match = CATEGORY_LINE.exec(line);
		if (match !== null) {
			const name = match[1].trim();
			if (name === '') continue;
			const title = `Category:${name}`;
			if (!categorySeen.has(title)) {
				categorySeen.add(title);
				categories.push(title);
			}
			continue;
		}
		if (!pageSeen.has(line)) {
			pageSeen.add(line);
			pages.push(line);
		}
	}
	return { pages, categories };
}
