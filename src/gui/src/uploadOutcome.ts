// 把上传任务的进度事件归并成"每个文件一条结果"，供上传页逐行标注。
//
// 事件标题是 `File:<目标文件名>`；页面用它反查回是哪一行（目标文件名 = 前缀 + 行内文件名）。
import type { ProgressEvent } from './types';

export interface UploadOutcome {
	/** 检查到的线上状态，如「已存在」 */
	online?: string;
	/** 本条的上传结果 */
	result?: string;
}

/** 事件标题去掉 File: 前缀 */
function keyOf(title: string): string {
	return title.replace(/^File:/i, '');
}

/** 归并 detail 与 edit 事件；后到的事件覆盖同类的先到者 */
export function outcomesFromEvents(events: ProgressEvent[]): Map<string, UploadOutcome> {
	const outcomes = new Map<string, UploadOutcome>();
	for (const event of events) {
		if (event.type === 'detail') {
			const online = event.fields['线上状态'];
			if (typeof online !== 'string') continue;
			outcomes.set(keyOf(event.title), { ...outcomes.get(keyOf(event.title)), online });
			continue;
		}
		if (event.type !== 'edit') continue;
		const key = keyOf(event.title);
		const previous = outcomes.get(key) ?? {};
		if (event.status === 'changed') {
			outcomes.set(key, { ...previous, result: event.message?.startsWith('[DRY-RUN]') === true ? '空跑' : '成功' });
		} else if (event.status === 'skipped') {
			outcomes.set(key, { ...previous, result: event.message ?? '已跳过' });
		} else {
			outcomes.set(key, { ...previous, result: `失败：${event.message ?? '未知原因'}` });
		}
	}
	return outcomes;
}
