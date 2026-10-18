// 进度事件的纯文本渲染：与 React 无关，可被 node:test 直接跑。
// 供 ProgressPanel 与 LogView 复用——把结构化事件转成一行给人看的文字。
import type { ProgressEvent } from '../types';

/** 编辑事件的状态中文标签 */
const STATUS_LABEL: Record<'changed' | 'skipped' | 'failed', string> = {
	changed: '修改',
	skipped: '跳过',
	failed: '失败',
};

/** done 摘要里已知键的中文标签；未知键（如自动巡查的动态键）原样显示 */
const SUMMARY_LABEL: Record<string, string> = {
	changed: '修改',
	skipped: '跳过',
	staleSkipped: '跳过',
	failed: '失败',
	hits: '命中',
	scanned: '扫描',
	edited: '编辑',
	dryRun: '空跑',
	notDisplayed: '未展示',
	added: '新增',
	removed: '删除',
	undoFailed: '撤销失败',
	checked: '已检查',
};

/**
 * 毫秒转中文时长：不足 1 分用「N 秒」，不足 1 小时用「M 分 S 秒」，1 小时以上用「H 小时 M 分」。
 * 一律向下取整到能显示的最小单位，0 毫秒返回「0 秒」。
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (ms < 60_000) return `${totalSeconds} 秒`;
	if (ms < 3_600_000) {
		const minutes = Math.floor(ms / 60_000);
		const seconds = Math.floor((ms % 60_000) / 1000);
		return `${minutes} 分 ${seconds} 秒`;
	}
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	return `${hours} 小时 ${minutes} 分`;
}

/**
 * 进度条的三种形态：
 * - determinate：有总量，按比例填充；
 * - indeterminate：有进度但总量未知（如全量抓取镜像），显示流动动效；
 * - idle：该阶段压根没有进度数据（如「跳过同步」），只留静态空槽——
 *   不能转圈，否则会被误认为还在干活。
 */
export type BarMode = 'determinate' | 'indeterminate' | 'idle';

/** 由"是否有进度事件"与"总量是否已知"决定进度条形态 */
export function barMode(hasProgress: boolean, total: number | undefined): BarMode {
	if (!hasProgress) return 'idle';
	return total === undefined ? 'indeterminate' : 'determinate';
}

/** 把 done 事件的摘要对象拼成「修改 3，跳过 1」样式的字符串 */
function renderSummary(summary: Record<string, number>): string {
	return Object.entries(summary)
		.map(([key, value]) => `${SUMMARY_LABEL[key] ?? key} ${value}`)
		.join('，');
}

/** 一条进度事件转成一行日志文本 */
export function eventToLine(event: ProgressEvent): string {
	switch (event.type) {
		case 'start':
			return `开始任务：${event.task}`;
		case 'phase':
			return `── ${event.name} ──`;
		case 'progress': {
			const total = event.total === undefined ? '' : `/${event.total}`;
			const label = event.message === undefined ? '进度' : event.message;
			return `${label}（${event.done}${total}）`;
		}
		case 'detail': {
			const parts = Object.entries(event.fields).map(([key, value]) => `${key}：${value === null ? '（无）' : value}`);
			return [event.title, parts.join('，')].join(' · ');
		}
		case 'hit':
			return `命中：${event.title}`;
		case 'edit': {
			const parts = [event.title, STATUS_LABEL[event.status]];
			if (event.message !== undefined && event.message !== '') parts.push(event.message);
			return parts.join(' · ');
		}
		case 'done':
			return `完成：${renderSummary(event.summary)}`;
		case 'log':
			return event.message;
	}
}
