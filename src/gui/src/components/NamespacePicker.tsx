// 命名空间复选框：列出站点全部命名空间，勾选即纳入替换范围。
// 「同步镜像（增量更新）」对着已覆盖的范围做增量抓取，随时可点；
// 勾中「未同步（mirrored === false）」的命名空间时另给「抓取该命名空间」入口——
// 不自动抓取：误勾「文件」或「模板」会抓下几万页并写进本地镜像，必须由人明确触发。
import type { NamespaceInfo } from '../types';

interface NamespacePickerProps {
	namespaces: NamespaceInfo[];
	selected: number[];
	onChange: (selected: number[]) => void;
	/** 点「抓取该命名空间」，由页面发起 --sync-only + --add-namespaces 任务 */
	onFetch: (id: number) => void;
	/** 点「同步镜像（增量更新）」，由页面发起裸 --sync-only 任务 */
	onSync: () => void;
	disabled?: boolean;
	/** 同步/抓取任务进行中，按钮转圈禁用 */
	fetching?: boolean;
}

/** 命名空间复选框组 */
export function NamespacePicker({ namespaces, selected, onChange, onFetch, onSync, disabled = false, fetching = false }: NamespacePickerProps): React.JSX.Element {
	const selectedSet = new Set(selected);
	const toggle = (id: number, checked: boolean): void => {
		onChange(checked ? [...selected, id] : selected.filter((item) => item !== id));
	};
	// 勾中但未同步的命名空间：提示 + 抓取入口
	const unsynced = namespaces.filter((ns) => selectedSet.has(ns.id) && !ns.mirrored);

	return (
		<div className="namespace-picker">
			<div className="ns-toolbar">
				<button type="button" disabled={disabled || fetching} onClick={onSync}>
					{fetching ? '同步中…' : '同步镜像（增量更新）'}
				</button>
				<span className="hint">把已覆盖命名空间的最近改动抓进本地镜像；镜像没覆盖到的范围用下面的「抓取该命名空间」。</span>
			</div>
			<div className="ns-grid">
				{namespaces.length === 0 && <p className="hint">正在加载命名空间…</p>}
				{namespaces.map((ns) => (
					<label className="ns-item" key={ns.id}>
						<input type="checkbox" checked={selectedSet.has(ns.id)} disabled={disabled} onChange={(event) => toggle(ns.id, event.target.checked)} />
						<span>{ns.label}</span>
						{!ns.mirrored && <span className="ns-badge">未同步</span>}
					</label>
				))}
			</div>
			{unsynced.length > 0 && (
				<div className="ns-warning">
					<p className="hint danger">以下命名空间尚未同步进本地镜像，扫描搜不到内容，需要先抓取：</p>
					<ul>
						{unsynced.map((ns) => (
							<li key={ns.id}>
								<span>{ns.label}</span>
								<button type="button" disabled={disabled || fetching} onClick={() => onFetch(ns.id)}>
									{fetching ? '抓取中…' : '抓取该命名空间'}
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
