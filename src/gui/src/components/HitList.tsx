// 命中结果列表：每行页面名 + 命中处数 + 勾选框 + [看 diff]，
// 下面缩进列出每处匹配所在的那一行原文；[看 diff] 才按需展开整段改动。
import { useState } from 'react';
import { ApiError, api } from '../api';
import type { DiffLine, ScanPageHit } from '../types';
import { DiffView } from './DiffView';

/** 明细上限：服务端每页最多保留这么多条命中明细，超过要注明「仅列出前 N 处」 */
const DETAIL_NOTE_THRESHOLD = 50;

/** 一个页面展开的 diff 状态 */
type DiffState =
	| { status: 'loading' }
	| { status: 'lines'; lines: DiffLine[] }
	| { status: 'note'; text: string }
	| { status: 'error'; text: string };

interface HitListProps {
	scanName: string;
	hits: ScanPageHit[];
	/** 命中页总数（可能大于已载入的 hits.length，用于「加载更多」） */
	total: number;
	selected: Set<string>;
	onToggle: (title: string, checked: boolean) => void;
	onSelectAll: () => void;
	onSelectNone: () => void;
	/** 已提交成功的页面 → 已改处数，命中标记变绿 */
	applied: Map<string, number>;
	onLoadMore: () => void;
	loadingMore?: boolean;
}

/** 命中结果列表 */
export function HitList({ scanName, hits, total, selected, onToggle, onSelectAll, onSelectNone, applied, onLoadMore, loadingMore = false }: HitListProps): React.JSX.Element {
	const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
	const [open, setOpen] = useState<Set<string>>(new Set());

	const toggleDiff = (title: string): void => {
		const next = new Set(open);
		if (next.has(title)) {
			next.delete(title);
			setOpen(next);
			return;
		}
		next.add(title);
		setOpen(next);
		if (diffs[title] !== undefined) return;
		setDiffs((prev) => ({ ...prev, [title]: { status: 'loading' } }));
		api.scans
			.diff(scanName, title)
			.then((result) => setDiffs((prev) => ({ ...prev, [title]: { status: 'lines', lines: result.lines } })))
			.catch((reason: unknown) => {
				// unchanged / missing 是业务状态不是错误，转成友好文案；其余才标红
				const reasonCode = reason instanceof ApiError ? reason.body?.reason : undefined;
				if (reasonCode === 'unchanged') setDiffs((prev) => ({ ...prev, [title]: { status: 'note', text: '按当前规则已无匹配（页面内容或规则已变）' } }));
				else if (reasonCode === 'missing') setDiffs((prev) => ({ ...prev, [title]: { status: 'note', text: '线上已找不到这个页面' } }));
				else setDiffs((prev) => ({ ...prev, [title]: { status: 'error', text: reason instanceof ApiError ? reason.message : '取 diff 失败' } }));
			});
	};

	const renderDiff = (title: string): React.JSX.Element | null => {
		const state = diffs[title];
		if (state === undefined) return null;
		if (state.status === 'loading') return <p className="hint">正在取 diff…</p>;
		if (state.status === 'lines') return <DiffView lines={state.lines} />;
		if (state.status === 'note') return <p className="hint">{state.text}</p>;
		return <p className="error">{state.text}</p>;
	};

	return (
		<section className="hit-list">
			<div className="hit-head">
				<h3>命中结果（{total} 页）</h3>
				<div className="hit-actions">
					<button type="button" onClick={onSelectAll}>
						全选
					</button>
					<button type="button" onClick={onSelectNone}>
						全不选
					</button>
				</div>
			</div>

			{total === 0 && <p className="hint">没有命中页面。若确信应有命中，检查命名空间是否已同步、规则是否符合预期。</p>}

			<ul className="hit-items">
				{hits.map((hit) => {
					const appliedCount = applied.get(hit.title);
					const truncated = hit.hits > hit.matches.length;
					return (
						<li className={`hit-item${appliedCount !== undefined ? ' hit-applied' : ''}`} key={hit.title}>
							<div className="hit-line">
								<input type="checkbox" checked={selected.has(hit.title)} onChange={(event) => onToggle(hit.title, event.target.checked)} />
								<span className="hit-title">{hit.title}</span>
								<span className="hit-count">命中 {hit.hits} 处</span>
								{appliedCount !== undefined && <span className="hit-applied-badge">已改 {appliedCount} 处</span>}
								<button type="button" className="hit-diff-btn" onClick={() => toggleDiff(hit.title)}>
									{open.has(hit.title) ? '收起 diff' : '看 diff'}
								</button>
							</div>
							{hit.matches.length > 0 && (
								<ol className="hit-matches">
									{hit.matches.map((match, index) => (
										<li key={index}>
											<span className="hit-line-no">第 {match.line} 行</span>
											<code className="hit-line-text">{match.text}</code>
										</li>
									))}
								</ol>
							)}
							{truncated && <p className="hint">仅列出前 {hit.matches.length} 处（共 {hit.hits} 处，明细上限 {DETAIL_NOTE_THRESHOLD} 条）</p>}
							{open.has(hit.title) && <div className="hit-diff">{renderDiff(hit.title)}</div>}
						</li>
					);
				})}
			</ul>

			{hits.length < total && (
				<div className="hit-more">
					<button type="button" disabled={loadingMore} onClick={onLoadMore}>
						{loadingMore ? '加载中…' : `加载更多（已载入 ${hits.length}/${total}）`}
					</button>
				</div>
			)}
		</section>
	);
}
