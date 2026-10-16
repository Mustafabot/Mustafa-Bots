/**
 * 行级 diff：给"提交前看效果"与"历史里看改了什么"共用。
 * 前端渲染与服务端算 diff 用同一份实现，避免两边算法不一致。
 */

export type DiffOp = 'equal' | 'add' | 'del';

/** 一行差异；text 不含行尾换行 */
export interface DiffLine {
	op: DiffOp;
	text: string;
}

export interface DiffStats {
	added: number;
	removed: number;
	unchanged: number;
}

/** 行数超过它就退化为整段替换：这么大的 diff 逐行比对对人已无意义，但不能把 CPU 跑满 */
const LCS_LIMIT = 2000;

/** 按 \n 切行、剥掉行尾的 \r、丢掉末尾换行产生的空行，保证 CRLF/LF 与有无末尾换行的文本逐行等价 */
function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** 行级 diff：equal 的行按原顺序保留，del 在其后、add 在其后 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	if (oldLines.length > LCS_LIMIT || newLines.length > LCS_LIMIT) {
		return diffLarge(oldLines, newLines);
	}
	return diffByLcs(oldLines, newLines);
}

/** 动态规划求 LCS，再回溯成三色行序列 */
function diffByLcs(oldLines: string[], newLines: string[]): DiffLine[] {
	const n = oldLines.length;
	const m = newLines.length;
	// lcs[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			out.push({ op: 'equal', text: oldLines[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			out.push({ op: 'del', text: oldLines[i] });
			i++;
		} else {
			out.push({ op: 'add', text: newLines[j] });
			j++;
		}
	}
	while (i < n) out.push({ op: 'del', text: oldLines[i++] });
	while (j < m) out.push({ op: 'add', text: newLines[j++] });
	return out;
}

/** 超大文本：保留公共前后缀，中间整段作一删一增 */
function diffLarge(oldLines: string[], newLines: string[]): DiffLine[] {
	let head = 0;
	while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
	let tail = 0;
	while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
	const out: DiffLine[] = [];
	for (let k = 0; k < head; k++) out.push({ op: 'equal', text: oldLines[k] });
	for (let k = head; k < oldLines.length - tail; k++) out.push({ op: 'del', text: oldLines[k] });
	for (let k = head; k < newLines.length - tail; k++) out.push({ op: 'add', text: newLines[k] });
	for (let k = oldLines.length - tail; k < oldLines.length; k++) out.push({ op: 'equal', text: oldLines[k] });
	return out;
}

export function summarizeDiff(lines: DiffLine[]): DiffStats {
	const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 };
	for (const line of lines) {
		if (line.op === 'add') stats.added++;
		else if (line.op === 'del') stats.removed++;
		else stats.unchanged++;
	}
	return stats;
}
