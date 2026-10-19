/**
 * 还原队列的格式：wiki 页上的 <poem> 内一行一个文件名。
 *
 * 抽成纯逻辑模块由脚本与服务端共用：脚本据此决定处理哪些文件、跑完写回剩余的，
 * 服务端在界面上读同一份内容做展示与保存。格式只在这里定义一次。
 */
import Parser from 'wikiparser-node';

Parser.config = 'moegirl';

/** 队列页标题 */
export const QUEUE_PAGE = 'User:没有羽翼的格雷塔/BotConfig/FileRestore';

/**
 * 页面开头的说明文字。
 * 必须与脚本旧版清空队列时写出的正文逐字一致，否则"内容没变就不写"的判断会失效。
 */
export const QUEUE_HEADER = '{{用户 允许他人编辑}}\n需要还原的文件请填入下方<code><nowiki><poem></nowiki></code>标签中，一行一个，带File前缀。填写后请联系[[User talk:没有羽翼的格雷塔|操作者]]手动运行脚本。\n----\n';

/** 归一文件名：缺 `File:` 前缀就补上（前缀大小写不敏感，已带则原样保留） */
export function normalizeEntry(name: string): string {
	return /^file:/i.test(name) ? name : `File:${name}`;
}

/** 从页面正文里取出队列条目：<poem> 内逐行、去空白、补 `File:` 前缀、去重 */
export function parseQueue(content: string): string[] {
	const parsed = Parser.parse(content, QUEUE_PAGE);
	const poems = parsed.querySelectorAll<Parser.ExtToken>('ext#poem');
	if (poems.length === 0) {
		throw new Error(`队列页中未找到 <poem> 标签：${QUEUE_PAGE}`);
	}
	const entries: string[] = [];
	for (const node of poems) {
		const innerText: string | undefined = node.innerText;
		if (!innerText) continue;
		for (const line of innerText.split('\n')) {
			const trimmed = line.trim();
			if (trimmed !== '') entries.push(normalizeEntry(trimmed));
		}
	}
	// 归一之后再比：正文写法不同的同一文件（`A.png` 与 `File:A.png`）只保留一条
	return [...new Set(entries)];
}

/** 由条目生成队列页正文：说明文字 + poem 块 */
export function renderQueue(entries: string[]): string {
	const body = entries.length === 0 ? '<poem>\n</poem>' : `<poem>\n${entries.join('\n')}\n</poem>`;
	return `${QUEUE_HEADER}${body}`;
}
