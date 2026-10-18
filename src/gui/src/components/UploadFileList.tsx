// 上传文件列表：每行给出缩略图、来源、目标文件名、逐条信息与删除按钮。
// 缩略图直接给地址：本机文件走服务端的预览接口，外站地址交给浏览器加载（加载不出来就显示占位）。
import { useState } from 'react';
import { api } from '../api';
import { LICENSE_OPTIONS } from '../licenseOptions';
import type { UploadRow } from '../uploadTaskCodec';
import type { UploadOutcome } from '../uploadOutcome';

interface UploadFileListProps {
	rows: UploadRow[];
	/** 目标文件名 → 线上状态与本次结果 */
	outcomes: Map<string, UploadOutcome>;
	/** 目标文件名 = 前缀 + 行内文件名 */
	prefix: string;
	/** 当前选中的行，供「同步文件信息」用 */
	selectedId: string | null;
	onSelect: (id: string) => void;
	onChange: (rows: UploadRow[]) => void;
	disabled?: boolean;
}

/** 改一行里的某个字段 */
function patchRow(rows: UploadRow[], id: string, patch: Partial<UploadRow>): UploadRow[] {
	return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/** 上传文件列表 */
export function UploadFileList({ rows, outcomes, prefix, selectedId, onSelect, onChange, disabled = false }: UploadFileListProps): React.JSX.Element {
	// 缩略图加载失败的行 id：外站图被禁热链或已失效时退回与「无预览」相同的占位，
	// 不给浏览器破图标留位置
	const [failedThumbs, setFailedThumbs] = useState<ReadonlySet<string>>(new Set());
	if (rows.length === 0) {
		return <p className="hint">还没有文件。可以粘贴一批地址，或选择本机文件。</p>;
	}
	return (
		<ul className="upload-rows">
			{rows.map((row) => {
				// 脚本侧解析配置时会把前缀与文件名两端的空白去掉，这里按同样规则拼目标文件名，
				// 否则行里带了空格就对不上事件里的标题，逐条结果会静默不显示
				const target = `${prefix.trim()}${row.filename.trim()}`;
				const outcome = outcomes.get(target) ?? {};
				const source = row.url !== '' ? row.url : row.file;
				const preview = row.url !== '' ? row.url : row.file !== '' ? api.uploads.previewUrl(row.file.split(/[\\/]/).pop() ?? '') : '';
				const showThumb = preview !== '' && !failedThumbs.has(row.id);
				return (
					<li className={`upload-row${selectedId === row.id ? ' upload-row-selected' : ''}`} key={row.id} onClick={() => onSelect(row.id)}>
						<div className="upload-thumb">
							{showThumb ? <img src={preview} alt="" onError={() => setFailedThumbs((prev) => new Set(prev).add(row.id))} /> : <span className="hint">无预览</span>}
						</div>
						<div className="upload-fields">
							<div className="upload-source">
								<span className="hint">来源</span>
								<code>{source === '' ? '（未填）' : source}</code>
								{outcome.online !== undefined && <span className="upload-online">线上：{outcome.online}</span>}
								{outcome.result !== undefined && <span className={`upload-result${outcome.result.startsWith('失败') ? ' upload-result-failed' : ''}`}>{outcome.result}</span>}
							</div>
							<div className="upload-inputs">
								<label>
									文件名
									<input type="text" value={row.filename} disabled={disabled} onChange={(event) => onChange(patchRow(rows, row.id, { filename: event.target.value }))} />
								</label>
								<label>
									授权
									<select value={row.license} disabled={disabled} onChange={(event) => onChange(patchRow(rows, row.id, { license: event.target.value }))}>
										<option value="">（默认 Copyright）</option>
										{LICENSE_OPTIONS.map((option) => (
											<option key={option.value} value={option.value} title={option.title}>
												{option.value === 'none:gotoCommons' ? `${option.label}（批量上传不支持）` : option.label}
											</option>
										))}
									</select>
								</label>
								<label>
									角色名
									<input type="text" value={row.charaName} disabled={disabled} onChange={(event) => onChange(patchRow(rows, row.id, { charaName: event.target.value }))} />
								</label>
								<label>
									作者
									<input type="text" value={row.author} disabled={disabled} onChange={(event) => onChange(patchRow(rows, row.id, { author: event.target.value }))} />
								</label>
								<label>
									源地址
									<input type="text" value={row.source} disabled={disabled} onChange={(event) => onChange(patchRow(rows, row.id, { source: event.target.value }))} />
								</label>
							</div>
						</div>
						<button type="button" className="upload-remove" disabled={disabled} onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>
							删除
						</button>
					</li>
				);
			})}
		</ul>
	);
}
