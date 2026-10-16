// 前端共享类型：逐字镜像服务端各模块的接口形状。
// 字段名是 HTTP/SSE 的线上契约，必须与服务端一字不差——改这里等于改接口。
// 只镜像界面真正用到的字段，未用到的服务端字段略去。

// ── 任务描述符（镜像 src/core/descriptor.ts）──

/** 参数字段的基础属性 */
interface ParamSpecBase {
	/** 命令行开关，如 `--wiki` */
	flag: string;
	/** 表单标签 */
	label: string;
	description?: string;
}

/** 一个可渲染成表单控件的参数 */
export type ParamSpec =
	| (ParamSpecBase & { kind: 'boolean'; default?: boolean; danger?: boolean })
	| (ParamSpecBase & { kind: 'number'; default?: number; min?: number; max?: number; danger?: boolean })
	| (ParamSpecBase & { kind: 'string'; default?: string; placeholder?: string })
	| (ParamSpecBase & { kind: 'enum'; default: string; options: ReadonlyArray<{ value: string; label: string }> })
	| (ParamSpecBase & { kind: 'stringList'; separator: string; default?: string[] });

/** 位置参数：不挂 flag，按 index 顺序排在命令行最前 */
export interface PositionalSpec {
	kind: 'positional';
	/** 在表单值中的键名，与 flag 无关 */
	name: string;
	label: string;
	description?: string;
	index: number;
	required?: boolean;
}

export type AnySpec = ParamSpec | PositionalSpec;

/** 任务描述符：界面据它渲染表单并拼命令行 */
export interface TaskDescriptor {
	/** 稳定标识，前端与 API 用它引用任务 */
	id: string;
	label: string;
	/** 相对仓库根目录的脚本入口 */
	entry: string;
	/** 参数拼接风格：`space` 为 `--key value`，`equals` 为 `--key=value` */
	style: 'space' | 'equals';
	params: AnySpec[];
	/** 打开进度事件输出的开关，由服务端自动附加 */
	progressFlag: string;
	/** 静默人类可读日志的开关，由服务端自动附加 */
	quietFlag: string;
	/** 规则集参数开关；存在则该任务必须选择一个规则集 */
	rulesetFlag?: string;
}

/** 表单值：字符串、数字、布尔或字符串数组 */
export type ParamValue = string | number | boolean | string[];

/** `POST /api/task` 的请求体 */
export interface StartTaskBody {
	descriptorId: string;
	values: Record<string, ParamValue>;
	/** 该任务声明了 rulesetFlag 时必填 */
	rulesetName?: string;
	/** 提交选中的页面清单（服务端落成临时文件后注入 --submit） */
	submitTitles?: string[];
}

// ── 进度事件（镜像 src/core/progress.ts）──

/** 进度事件：七种分支与服务端联合类型一一对应 */
export type ProgressEvent =
	| { type: 'start'; task: string; at: number }
	| { type: 'phase'; name: string; at: number }
	| { type: 'progress'; done: number; total?: number; message?: string; at: number }
	| { type: 'hit'; title: string; at: number }
	| { type: 'edit'; title: string; status: 'changed' | 'skipped' | 'failed'; oldRevid: number | null; newRevid: number | null; message?: string; at: number }
	| { type: 'done'; summary: Record<string, number>; resultFile?: string; at: number }
	| { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };

// ── 任务记录（镜像 src/server/taskRunner.ts）──

export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface TaskRecord {
	id: string;
	descriptorId: string;
	label: string;
	argv: string[];
	status: TaskStatus;
	startedAt: number;
	endedAt: number | null;
	events: ProgressEvent[];
	summary: Record<string, number> | null;
}

/** SSE 帧里的任务元信息：TaskRecord 去掉 events（事件逐条下发，不随每帧重发） */
export type TaskMeta = Omit<TaskRecord, 'events'>;

// ── 替换规则（镜像 src/replace/replaceRules.ts）──

/** 单条替换规则 */
export interface ReplaceRule {
	/** 查找文本；regex 为 true 时按 JavaScript 正则解析 */
	from: string;
	/** 替换文本；regex 为 true 时支持 $1 等替换引用，可为空串（即删除） */
	to: string;
	/** 是否按正则解析 from */
	regex?: boolean;
	/** 是否忽略大小写 */
	ignoreCase?: boolean;
}

// ── 扫描结果（镜像 src/replace/scanResult.ts）──

/** 一处命中所在的行 */
export interface ScanMatchLine {
	/** 行号，从 1 开始 */
	line: number;
	/** 该行原文（去掉了行尾的 \r） */
	text: string;
	/** 匹配到的字串 */
	match: string;
	/** 命中的规则在 rules 数组中的下标 */
	rule: number;
}

/** 一个命中页面 */
export interface ScanPageHit {
	title: string;
	/** 真实命中处数（明细被截断时大于 matches.length） */
	hits: number;
	matches: ScanMatchLine[];
}

/** 一次扫描的完整结果 */
export interface ScanResult {
	/** 结果格式版本 */
	version: 1;
	wiki: string;
	/** 规则指纹，同规则重扫覆盖同一文件 */
	fingerprint: string;
	namespaces: number[];
	rules: ReplaceRule[];
	/** 本次扫描过的镜像页数 */
	scanned: number;
	createdAt: number;
	hits: ScanPageHit[];
}

/** 列表用的元信息：去掉命中明细，另给命中页数 */
export type ScanResultMeta = Omit<ScanResult, 'hits'> & { hitCount: number };

/** `GET /api/scans/:name` 的一页命中（镜像 src/server/scans.ts 的 ScanPageSlice） */
export interface ScanPageSlice {
	meta: ScanResultMeta;
	/** 命中页总数 */
	total: number;
	offset: number;
	limit: number;
	hits: ScanPageHit[];
}

// ── 命名空间（镜像 src/server/namespaces.ts）──

export interface NamespaceInfo {
	id: number;
	/** 界面显示名（站点本地化名；主命名空间用「主命名空间」） */
	label: string;
	/** MediaWiki 的英文规范名 */
	canonical: string;
	/** 是否主题命名空间（id 为偶数） */
	subject: boolean;
	/** 是否已在本地镜像覆盖范围内 */
	mirrored: boolean;
}

export interface NamespaceList {
	wiki: 'zh' | 'cm';
	/** 镜像当前覆盖的命名空间编号 */
	mirrorNamespaces: number[];
	namespaces: NamespaceInfo[];
}

// ── 行级 diff（镜像 src/core/pageDiff.ts）──

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

/** `GET /api/scans/:name/diff?page=` 的返回 */
export interface ScanDiffResult {
	page: string;
	lines: DiffLine[];
	stats: DiffStats;
}

/** `GET /api/history/:id/diff?page=` 的返回 */
export interface HistoryDiffResult {
	page: string;
	oldRevid: number | null;
	newRevid: number | null;
	lines: DiffLine[];
	stats: DiffStats;
}

// ── 历史（镜像 src/server/history.ts，字段名以数据库列别名为准）──

/** 历史任务行（服务端 TaskSummaryRow）；paramsJson 是参数对象的 JSON 字符串，不是对象 */
export interface HistoryTaskRow {
	id: string;
	descriptorId: string;
	label: string;
	paramsJson: string;
	startedAt: number;
	endedAt: number | null;
	status: string;
	summaryJson: string | null;
}

/** 历史任务里的一条改动页面（服务端 TaskPageRow） */
export interface HistoryPageRow {
	taskId: string;
	title: string;
	action: string;
	oldRevid: number | null;
	newRevid: number | null;
	message: string | null;
}

/** `GET /api/history/:id` 的返回 */
export interface HistoryTaskDetail {
	task: HistoryTaskRow;
	pages: HistoryPageRow[];
}

/**
 * 历史任务落库的参数对象（`HistoryTaskRow.paramsJson` 解析后的形状）。
 * 除描述符的 values（`--wiki`、`--namespace`、各开关）外，服务端在有规则集时会附带 `__ruleset`
 * ——跑这次任务时草稿正文的快照，历史页据此还原"当时跑的是哪套规则"。
 */
export interface HistoryTaskParams {
	/** 所用规则集的名称与当时草稿的 JSON 原文；无规则集的任务没有这个键 */
	__ruleset?: { name: string; content: string };
	[key: string]: unknown;
}

// ── 规则集（镜像 src/server/rulesets.ts）──

/** 规则集草稿 */
export interface RulesetDraft {
	name: string;
	baseRevid: number | null;
	content: string;
	updatedAt: number;
}

/** 规则集汇总 */
export interface RulesetSummary {
	name: string;
	pageTitle: string;
	draftUpdatedAt: number | null;
}

/** 规则集线上版本（服务端 fetchRemote 的返回） */
export interface RulesetRemote {
	content: string | null;
	revid: number | null;
}

/**
 * 发布成功的结果（服务端 RulesetPublisher.publish 的 ok:true 分支）。
 * 冲突 / 线上不存在时服务端回 409，由 `api.rulesets.publish` 抛 ApiError——
 * 失败信息在 `ApiError.body`（reason 为 conflict/missing，另附 remote/remoteRevid），不在此类型里。
 */
export interface PublishSuccess {
	ok: true;
	revid: number | null;
}
