// 规则表单：一行一条，左边「从」、右边「到」，每条一个「正则」勾选框。
// 勾上「正则」时「从」要写成 /模式/flags 的正则字面量，例如 /苹果/gi 就是不区分大小写。
// 不做「忽略大小写」勾选框——不区分大小写由字面量里的 i 标志表达（即上面的 /苹果/gi）。
// 表单状态里的 ignoreCase 保留但不可编辑，避免加载进来的预设悄悄丢字段。
import type { RuleFormState } from '../rulesetCodec';

type RuleRow = RuleFormState['rules'][number];

interface RuleEditorProps {
	rules: RuleRow[];
	onChange: (rules: RuleRow[]) => void;
	disabled?: boolean;
}

/** 规则编辑器 */
export function RuleEditor({ rules, onChange, disabled = false }: RuleEditorProps): React.JSX.Element {
	const update = (index: number, patch: Partial<RuleRow>): void => {
		onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
	};
	const remove = (index: number): void => {
		onChange(rules.filter((_, i) => i !== index));
	};
	const add = (): void => {
		onChange([...rules, { from: '', to: '', regex: false, ignoreCase: false }]);
	};

	return (
		<div className="rule-editor">
			<div className="rule-head">
				<span className="rule-col-from">从</span>
				<span className="rule-col-arrow" />
				<span className="rule-col-to">到</span>
				<span className="rule-col-flag">正则</span>
				<span className="rule-col-remove" />
			</div>
			{rules.length === 0 && <p className="hint">还没有规则，点下方「添加一条」开始。</p>}
			{rules.map((rule, index) => (
				<div className="rule-row" key={index}>
					<input
						className="rule-col-from"
						type="text"
						value={rule.from}
						placeholder="查找文本"
						disabled={disabled}
						onChange={(event) => update(index, { from: event.target.value })}
					/>
					<span className="rule-col-arrow">→</span>
					<input
						className="rule-col-to"
						type="text"
						value={rule.to}
						placeholder="替换为（可留空即删除）"
						disabled={disabled}
						onChange={(event) => update(index, { to: event.target.value })}
					/>
					<label className="rule-col-flag">
						<input type="checkbox" checked={rule.regex} disabled={disabled} onChange={(event) => update(index, { regex: event.target.checked })} />
					</label>
					<button type="button" className="rule-col-remove" title="删除这一条" disabled={disabled} onClick={() => remove(index)}>
						×
					</button>
				</div>
			))}
			<button type="button" className="rule-add" disabled={disabled} onClick={add}>
				+ 添加一条
			</button>
		</div>
	);
}
