// 规则集的命名与目标页：纯函数，供界面据预设名推出默认配置页标题。
//
// 与服务端 src/server/rulesets.ts 的 `pageTitleFor` 保持一致（两端各有常量，
// 与扫描结果文件名的做法相同）：服务端拿它当缺省目标页，界面拿它预填输入框。

/** 配置页前缀：发布规则集的默认落点 */
export const CONFIG_PAGE_PREFIX = 'User:没有羽翼的格雷塔/BotConfig/';

/**
 * 预设名 → 默认配置页标题。名字为空时只剩前缀，用作输入框的占位提示。
 * 界面上可以改成任意页面标题，这里只提供默认值。
 */
export function configPageFor(name: string): string {
	return CONFIG_PAGE_PREFIX + name.trim();
}
