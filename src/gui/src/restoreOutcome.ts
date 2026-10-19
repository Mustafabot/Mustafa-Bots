// 把文件还原任务的进度事件归并成"每个文件一条状态"，供还原页逐行标注。
//
// 事件标题是 `File:<文件名>`；页面用它反查回是哪一行。
import type { ProgressEvent } from './types';

export interface RestoreOutcome {
	/** detail 事件给的删除日志（最后编辑者、理由、时间、版本数、可否还原） */
	log?: Record<string, string | number | null>;
	/** edit 事件给的本条结果 */
	result?: string;
	/** 是否可还原：报告说不可还原的行在界面上标灰、不勾选、不计数 */
	restorable: boolean;
}

/** 事件标题去掉 File: 前缀 */
function keyOf(title: string): string {
	return title.replace(/^File:/i, '');
}

/** 依据当前状态判断能否还原：删除记录里没有、或结果说跳过，都算不可还原 */
function restorableOf(state: RestoreOutcome): boolean {
	if (state.log?.['可否还原'] === '不在删除记录中') return false;
	if (state.result !== undefined && state.result.startsWith('跳过')) return false;
	return true;
}

/** 归并 detail 与 edit 事件；后到的事件覆盖同类的先到者 */
export function restoreOutcomesFromEvents(events: ProgressEvent[]): Map<string, RestoreOutcome> {
	const outcomes = new Map<string, RestoreOutcome>();
	for (const event of events) {
		if (event.type === 'detail') {
			const key = keyOf(event.title);
			const next: RestoreOutcome = { ...(outcomes.get(key) ?? { restorable: true }), log: event.fields };
			next.restorable = restorableOf(next);
			outcomes.set(key, next);
		} else if (event.type === 'edit') {
			const key = keyOf(event.title);
			const label = event.status === 'changed'
				? (event.message?.startsWith('[DRY-RUN]') === true ? '空跑' : (event.message ?? '已还原'))
				: event.status === 'skipped' ? (event.message ?? '跳过') : `失败：${event.message ?? '未知原因'}`;
			const next: RestoreOutcome = { ...(outcomes.get(key) ?? { restorable: true }), result: label };
			next.restorable = restorableOf(next);
			outcomes.set(key, next);
		}
	}
	return outcomes;
}
