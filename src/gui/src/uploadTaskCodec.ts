// 上传页的表单状态与任务 JSON 的互转。
//
// 任务 JSON 的形状与 src/upload/uploadConfig.ts 一致（脚本与服务端共用的那份），
// 界面上把可选的空字段留空，编码时省略，保持手写 JSON 的观感。

/** 一行文件：来源二选一，其余是每个文件独立的信息 */
export interface UploadRow {
	/** 本地行标识，只用于 React key 与按行更新 */
	id: string;
	/** 来源：外站地址 */
	url: string;
	/** 来源：本机文件路径（服务端暂存后的路径） */
	file: string;
	filename: string;
	charaName: string;
	author: string;
	source: string;
	license: string;
}

export interface UploadFormState {
	prefix: string;
	categories: string[];
	comment: string;
	rows: UploadRow[];
}

/** 从地址或本机路径里取末段当文件名的预填值；取不到就留空 */
function suggestedFilename(source: { url?: string; file?: string }): string {
	const raw = source.url ?? source.file ?? '';
	const withoutQuery = raw.split(/[?#]/)[0];
	const last = withoutQuery.split(/[\\/]/).pop() ?? '';
	return last === '' ? '' : decodeURIComponent(last);
}

/** 造一行；粘贴地址与选择本机文件都走它 */
export function makeRow(source: { url?: string; file?: string }): UploadRow {
	return {
		id: crypto.randomUUID(),
		url: source.url ?? '',
		file: source.file ?? '',
		filename: suggestedFilename(source),
		charaName: '',
		author: '',
		source: '',
		license: '',
	};
}

/** 表单状态 → 任务 JSON 字符串（可直接当 rulesetContent 下发） */
export function encodeUploadTask(state: UploadFormState): string {
	const payload: Record<string, unknown> = {};
	if (state.prefix !== '') payload.prefix = state.prefix;
	if (state.categories.length > 0) payload.categories = state.categories;
	if (state.comment !== '') payload.comment = state.comment;
	payload.files = state.rows.map((row) => {
		const file: Record<string, unknown> = {};
		if (row.url !== '') file.url = row.url;
		if (row.file !== '') file.file = row.file;
		file.filename = row.filename;
		if (row.charaName !== '') file.charaName = row.charaName;
		if (row.author !== '') file.author = row.author;
		if (row.source !== '') file.source = row.source;
		if (row.license !== '') file.license = row.license;
		return file;
	});
	return JSON.stringify(payload, null, '\t');
}

/** 取字符串字段；非字符串一律当没有 */
function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * 任务 JSON → 表单状态；JSON 坏掉或字段缺省时给出可用的默认值，不抛错。
 * 无法识别的结构一律退回空表单，保证界面永远拿到能渲染的状态。
 */
export function decodeUploadTask(content: string): UploadFormState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { prefix: '', categories: [], comment: '', rows: [] };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { prefix: '', categories: [], comment: '', rows: [] };
	}
	const data = parsed as Record<string, unknown>;
	const categories = Array.isArray(data.categories) ? data.categories.filter((item): item is string => typeof item === 'string' && item !== '') : [];
	const rows = Array.isArray(data.files)
		? data.files.map((item): UploadRow => {
				const entry = (item !== null && typeof item === 'object' ? item : {}) as Record<string, unknown>;
				return {
					id: crypto.randomUUID(),
					url: text(entry.url),
					file: text(entry.file),
					filename: text(entry.filename),
					charaName: text(entry.charaName),
					author: text(entry.author),
					source: text(entry.source),
					license: text(entry.license),
				};
			})
		: [];
	return { prefix: text(data.prefix), categories, comment: text(data.comment), rows };
}
