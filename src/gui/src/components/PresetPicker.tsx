// 预设选择器：起名字存草稿、从下拉调出来接着改、覆盖保存或发布回 wiki 配置页。
// 草稿（api.rulesets.save）供扫描/提交时脚本读取；发布（api.rulesets.publish）才写回配置页留痕。
import { useState } from 'react';
import type { RulesetSummary } from '../types';

interface PresetPickerProps {
	presets: RulesetSummary[];
	/** 当前预设名（受控） */
	name: string;
	onNameChange: (name: string) => void;
	/** 从下拉选中一个预设名，页面据此读取草稿内容填回表单 */
	onLoad: (name: string) => void;
	/** 把当前表单存为草稿（同名即覆盖） */
	onSave: (name: string) => void;
	/** 把草稿发布回 wiki 配置页 */
	onPublish: (name: string) => void;
	busy?: boolean;
}

/** 预设选择器 */
export function PresetPicker({ presets, name, onNameChange, onLoad, onSave, onPublish, busy = false }: PresetPickerProps): React.JSX.Element {
	const [selected, setSelected] = useState('');
	const trimmed = name.trim();
	const exists = presets.some((preset) => preset.name === trimmed);

	const load = (value: string): void => {
		setSelected(value);
		if (value !== '') {
			onNameChange(value);
			onLoad(value);
		}
	};

	return (
		<div className="preset-picker">
			<div className="preset-row">
				<label className="preset-field">
					<span>载入预设</span>
					<select value={selected} disabled={busy} onChange={(event) => load(event.target.value)}>
						<option value="">— 选择已有预设 —</option>
						{presets.map((preset) => (
							<option key={preset.name} value={preset.name}>
								{preset.name}
								{preset.draftUpdatedAt === null ? '（仅线上）' : ''}
							</option>
						))}
					</select>
				</label>
				<label className="preset-field">
					<span>预设名</span>
					<input type="text" value={name} placeholder="给这套规则起个名字" disabled={busy} onChange={(event) => onNameChange(event.target.value)} />
				</label>
				<button type="button" disabled={busy || trimmed === ''} onClick={() => onSave(trimmed)}>
					{exists ? '覆盖保存' : '保存为预设'}
				</button>
				<button type="button" disabled={busy || trimmed === ''} onClick={() => onPublish(trimmed)}>
					发布到配置页
				</button>
			</div>
			{exists && <p className="hint">预设「{trimmed}」已存在，「保存」将覆盖它的草稿。</p>}
		</div>
	);
}
