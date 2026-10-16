// 行级 diff 渲染：add 绿底、del 红底、equal 灰字。
// 文本替换页的「看 diff」与历史页共用。
import type { DiffLine } from '../types';

/** 超过这个行数就只渲染头尾，避免一次铺开上万行把浏览器拖死 */
const CAP = 2000;
/** 截断时前后各保留的行数 */
const HALF = 500;

/** 一行 diff 的类名：op 决定底色 */
const OP_CLASS: Record<DiffLine['op'], string> = {
	add: 'diff-add',
	del: 'diff-del',
	equal: 'diff-equal',
};

/** 行首符号：新增 +、删除 -、未变空格 */
const OP_SIGN: Record<DiffLine['op'], string> = {
	add: '+',
	del: '-',
	equal: ' ',
};

/**
 * 渲染一段行级 diff。
 * 行数超过 CAP 时只渲染前 HALF 与后 HALF 行，中间插一行「中间省略 N 行」——
 * 命中页的 diff 通常很短，截断是给意外的巨型改动兜底。
 */
export function DiffView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
	if (lines.length === 0) return <p className="hint">没有可显示的差异。</p>;

	const truncated = lines.length > CAP;
	const shown = truncated ? [...lines.slice(0, HALF), null, ...lines.slice(lines.length - HALF)] : lines;
	const omitted = lines.length - HALF * 2;

	return (
		<div className="diff-view">
			{shown.map((line, index) =>
				line === null ? (
					<div className="diff-omitted" key={`omitted-${index}`}>
						中间省略 {omitted} 行
					</div>
				) : (
					<div className={`diff-line ${OP_CLASS[line.op]}`} key={`${index}-${line.op}`}>
						<span className="diff-sign">{OP_SIGN[line.op]}</span>
						<span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
					</div>
				),
			)}
		</div>
	);
}
