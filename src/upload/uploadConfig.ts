/**
 * 上传任务的配置格式、校验与页面正文生成。
 *
 * 抽成纯模块由脚本与 GUI 服务端共用：服务端在界面上做校验提示与预览时用同一套规则，
 * 不必把"目标文件名怎么拼""协议模板怎么填"再写一遍。
 */

/** 共享站单文件上限：siteinfo 的 maxuploadsize 即 20971520 字节 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 上限的人类可读文本（整数 MB）：脚本与服务端共用，免得提示文字与常量走散 */
export const MAX_UPLOAD_SIZE_TEXT = `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;

/** 批量上传不许用的协议：它要求逐文件填授权信息，得走普通上传工具 */
export const BULK_FORBIDDEN_LICENSE = 'none:gotoCommons';

/** 授权协议选项：value 是写进正文的模板名，label 与 title 是界面上显示的文字 */
export const LICENSE_OPTIONS: ReadonlyArray<{ group: string; value: string; label: string; title?: string }> = [
	{ group: 'CC协议', value: 'CC Zero', label: 'CC-0', title: '作者授权以无著作权方式使用' },
	{ group: 'CC协议', value: 'CC BY', label: 'CC BY 3.0', title: '作者授权以署名方式使用，该授权需兼容 3.0 协议' },
	{ group: 'CC协议', value: 'CC BY-SA', label: 'CC BY-SA 3.0', title: '作者授权以署名-相同方式使用，该授权需兼容 3.0 协议' },
	{ group: 'CC协议', value: 'CC BY-NC-SA', label: 'CC BY-NC-SA 3.0', title: '作者授权以署名-非商业使用-相同协议使用，该授权需兼容 3.0 协议' },
	{ group: '公有领域', value: 'PD-Old', label: '作者离世一定年限后流入公有领域' },
	{ group: '公有领域', value: 'PD-Other', label: '其他原因流入公有领域' },
	{ group: '其他', value: 'Copyright', label: '原作者保留权利', title: '原作者没有明确的授权声明' },
	{ group: '其他', value: BULK_FORBIDDEN_LICENSE, label: '原作者授权萌百使用' },
	{ group: '其他', value: '可自由使用', label: '可自由使用', title: '作者放弃版权或声明可自由使用' },
	{ group: '其他', value: '萌娘百科版权所有', label: '萌娘百科版权所有' },
];

export interface UploadFileEntry {
	/** 来源：外站地址 */
	url?: string;
	/** 来源：本机文件路径 */
	file?: string;
	/** 目标文件名，不带 File: 前缀；前缀由 config.prefix 拼上 */
	filename: string;
	charaName?: string;
	author?: string;
	source?: string;
	license?: string;
}

export interface UploadTaskConfig {
	/** 拼在每条目标文件名前面的前缀 */
	prefix?: string;
	/** 整批共享的分类 */
	categories?: string[];
	/** 覆盖自动生成的上传摘要 */
	comment?: string;
	files: UploadFileEntry[];
}

export interface UploadIssue {
	/** 第几条，从 1 开始；整批性的问题记 0 */
	index: number;
	filename: string;
	message: string;
}

/** 探测本机文件：不存在或读不到大小时如实返回，由校验判断 */
export type LocalFileProbe = (path: string) => { exists: boolean; size: number | null };

/** 取非空字符串，空串与空白一律当没有 */
function optionalText(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 解析配置正文；JSON 坏掉或形状不对时抛错，信息面向使用者 */
export function parseUploadConfig(text: string): UploadTaskConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`配置不是合法的 JSON：${(error as Error).message}`, { cause: error });
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是一个对象');
	const raw = parsed as Record<string, unknown>;
	// 旧格式把文件名与正文交给顶层 article/text 推导，如今每条要自带 filename，
	// 命中时直接说清楚，免得落到逐条的通用报错上让人猜
	if ('article' in raw || 'text' in raw) {
		throw new Error('配置里的 article / text 字段已移除：现在每条 files 条目要自带 filename，共享字段改用 prefix / categories / comment');
	}
	if (!Array.isArray(raw.files)) throw new Error('配置缺少 files 数组');

	const categories = Array.isArray(raw.categories)
		? raw.categories.map(optionalText).filter((name): name is string => name !== undefined)
		: undefined;
	const files = raw.files.map((item, index): UploadFileEntry => {
		if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`files[${index}] 必须是一个对象`);
		const entry = item as Record<string, unknown>;
		return {
			url: optionalText(entry.url),
			file: optionalText(entry.file),
			filename: optionalText(entry.filename) ?? '',
			charaName: optionalText(entry.charaName),
			author: optionalText(entry.author),
			source: optionalText(entry.source),
			license: optionalText(entry.license),
		};
	});

	return { prefix: optionalText(raw.prefix), categories, comment: optionalText(raw.comment), files };
}

/** 拼在每条目标文件名前面的前缀；前缀为空时原样返回文件名 */
export function targetFilename(config: UploadTaskConfig, entry: UploadFileEntry): string {
	return `${config.prefix ?? ''}${entry.filename}`;
}

/** 逐条检查配置；返回空数组表示可以上传 */
export function validateUploadConfig(config: UploadTaskConfig, probe?: LocalFileProbe): UploadIssue[] {
	const issues: UploadIssue[] = [];
	if (config.files.length === 0) {
		issues.push({ index: 0, filename: '', message: 'files 是空数组，没有要上传的文件' });
		return issues;
	}

	const knownLicenses = new Set(LICENSE_OPTIONS.map((option) => option.value));
	const hasSharedCategories = (config.categories ?? []).length > 0;
	/** 已经出现过的目标文件名 → 是第几条 */
	const seen = new Map<string, number>();

	for (const [position, entry] of config.files.entries()) {
		const index = position + 1;
		const where = entry.filename === '' ? `files[${position}]` : `files[${position}]（${entry.filename}）`;
		const add = (message: string): void => {
			issues.push({ index, filename: entry.filename, message: `${where}：${message}` });
		};

		// 目标文件名不带 File: 前缀：前缀由 config.prefix 拼上，写进 filename 会拼成 File:File:x.png
		if (entry.filename === '') add('filename 不能为空');
		else if (/^File:/i.test(entry.filename)) add('filename 不要带 File: 前缀，前缀会自动加上');

		if (entry.url !== undefined && entry.file !== undefined) {
			add('url 与 file 只能给一个');
		} else if (entry.url === undefined && entry.file === undefined) {
			add('必须给出 url 或 file');
		}

		if (entry.url !== undefined) {
			try {
				const parsed = new URL(entry.url);
				if (!['http:', 'https:'].includes(parsed.protocol)) add('URL 协议必须是 http 或 https');
			} catch {
				add('URL 格式无效');
			}
		}

		if (entry.file !== undefined && probe !== undefined) {
			const info = probe(entry.file);
			if (!info.exists) add(`本机文件不存在：${entry.file}`);
			else if (info.size !== null && info.size > MAX_UPLOAD_BYTES) add(`本机文件超过 ${MAX_UPLOAD_SIZE_TEXT} 上限（共享站的上限）`);
		}

		// 重名按"拼上前缀之后"比，空格连续出现同样算同一个名字
		const target = targetFilename(config, entry).replace(/\s+/g, ' ');
		if (target !== '') {
			const previous = seen.get(target);
			if (previous === undefined) seen.set(target, index);
			else add(`目标文件名与第 ${previous} 条重复（${target}）`);
		}

		if (!hasSharedCategories && entry.charaName === undefined && entry.author === undefined && entry.source === undefined) {
			add('分类、角色名、作者、源地址至少要填一项');
		}

		if (entry.license !== undefined) {
			if (entry.license === BULK_FORBIDDEN_LICENSE) add('授权协议选了「原作者授权萌百使用」，批量上传不允许，请走普通上传工具');
			else if (!knownLicenses.has(entry.license)) add(`不认识的授权协议：${entry.license}`);
		}
	}

	return issues;
}

/** 默认摘要的开头；后面按条目拼具体信息 */
export const DEFAULT_UPLOAD_COMMENT = '机器人：批量上传文件';

/**
 * 查线上存在性用的标题归一：MediaWiki 会把首字母转大写、把下划线当空格，
 * 不按同样规则归一就会出现"明明存在却查不到"。
 */
export function normalizeFileTitle(name: string): string {
	const withoutPrefix = name.replace(/^File:/i, '').replace(/_/g, ' ');
	return withoutPrefix === '' ? '' : withoutPrefix.charAt(0).toUpperCase() + withoutPrefix.slice(1);
}

/** 文件页正文：分类行、源地址、授权协议模板 */
export function generateFilePageText(config: UploadTaskConfig, entry: UploadFileEntry): string {
	const metaCategories = `${entry.charaName ? `[[分类:${entry.charaName}]]` : ''}${entry.author ? `[[分类:作者:${entry.author}]]` : ''}`;
	const categories = (config.categories ?? []).map((name) => `[[分类:${name}]]`).join('');
	// 分类行始终占一行（全空时就是空行），源地址没有则整行不输出
	const lines = ['== 文件说明 ==', metaCategories + categories];
	if (entry.source) lines.push(`源地址：${entry.source}`);
	lines.push('== 授权协议 ==', `{{${entry.license ?? 'Copyright'}}}`);
	return lines.join('\n');
}

/** 上传摘要：配置给了 comment 就用它，否则按协议、人物、作者、源地址、其他分类拼 */
export function generateUploadComment(config: UploadTaskConfig, entry: UploadFileEntry): string {
	if (config.comment !== undefined) return config.comment;
	const parts: string[] = [];
	if (entry.license !== undefined) parts.push(`协议：${entry.license}`);
	if (entry.charaName !== undefined) parts.push(`人物：[[分类:${entry.charaName}|${entry.charaName}]]`);
	if (entry.author !== undefined) parts.push(`作者：[[分类:作者:${entry.author}|${entry.author}]]`);
	if (entry.source !== undefined) parts.push(`源地址：${entry.source}`);
	const categories = config.categories ?? [];
	if (categories.length > 0) parts.push(`其他分类：${categories.map((name) => `[[分类:${name}]]`).join('、')}`);
	return [DEFAULT_UPLOAD_COMMENT, ...parts].join('，');
}
