// 链接替换规则：一行一条「从 → 到」，两端都可含 #锚点。
// 不做正则——链接替换按标题精确匹配，与文本替换的规则语义不同，故不复用那边的编辑器。
import type { LinkRule } from '../linkConfigCodec';

interface LinkRuleListProps {
	rules: LinkRule[];
	onChange: (rules: LinkRule[]) => void;
	disabled?: boolean;
}

/** 链接替换规则列表 */
export function LinkRuleList({ rules, onChange, disabled = false }: LinkRuleListProps): React.JSX.Element {
	const update = (index: number, patch: Partial<LinkRule>): void => {
		onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
	};
	return (
		<div className="rule-editor">
			<div className="rule-head">
				<span className="rule-col-from">从</span>
				<span className="rule-col-arrow" />
				<span className="rule-col-to">到</span>
				<span className="rule-col-remove" />
			</div>
			{rules.length === 0 && <p className="hint">还没有规则，点下方「添加一条」开始。</p>}
			{rules.map((rule, index) => (
				<div className="rule-row" key={index}>
					<input className="rule-col-from" type="text" value={rule.from} disabled={disabled} placeholder="旧标题或旧标题#锚点" onChange={(event) => update(index, { from: event.target.value })} />
					<span className="rule-col-arrow">→</span>
					<input className="rule-col-to" type="text" value={rule.to} disabled={disabled} placeholder="新标题或新标题#锚点" onChange={(event) => update(index, { to: event.target.value })} />
					<button type="button" className="rule-col-remove" disabled={disabled} onClick={() => onChange(rules.filter((_, i) => i !== index))}>
						删除
					</button>
				</div>
			))}
			<button type="button" className="rule-add" disabled={disabled} onClick={() => onChange([...rules, { from: '', to: '' }])}>
				添加一条
			</button>
		</div>
	);
}
