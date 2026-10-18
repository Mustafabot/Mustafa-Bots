/** 任务描述符：GUI 用它渲染表单，也用它把表单值还原成命令行参数 */

interface ParamSpecBase {
	/** 命令行开关，如 `--wiki` */
	flag: string;
	/** 表单标签 */
	label: string;
	description?: string;
}

export type ParamSpec =
	| (ParamSpecBase & { kind: 'boolean'; default?: boolean; danger?: boolean })
	| (ParamSpecBase & { kind: 'number'; default?: number; min?: number; max?: number; danger?: boolean })
	| (ParamSpecBase & { kind: 'string'; default?: string; placeholder?: string })
	| (ParamSpecBase & { kind: 'enum'; default: string; options: ReadonlyArray<{ value: string; label: string }> })
	| (ParamSpecBase & { kind: 'stringList'; separator: string; default?: string[] });

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
	/** 该脚本的人类可读日志静默开关，由服务端自动附加：GUI 拉起的任务不需要逐页日志 */
	quietFlag: string;
	/** 专属页面的路由名；存在则任务卡片直达该页，不走通用运行页 */
	page?: string;
	/** 配置文件开关；存在则该任务必须有配置（内容直传或本地草稿），仅同步镜像除外 */
	configFileFlag?: string;
	/** 配置来源的白名单键，在服务端 routes.ts 的草稿库映射里登记；未登记的值会抛错。缺省 rulesets */
	configSource?: string;
}

export type ParamValue = string | number | boolean | string[];

/**
 * 把表单值序列化为 argv。
 * 位置参数按 index 升序排在最前，其余参数按 params 声明顺序排列。
 */
export function buildArgv(descriptor: TaskDescriptor, values: Record<string, ParamValue>): string[] {
	const argv: string[] = [];
	const positional = descriptor.params
		.filter((spec): spec is PositionalSpec => spec.kind === 'positional')
		.sort((a, b) => a.index - b.index);
	for (const spec of positional) {
		const value = values[spec.name];
		if (typeof value === 'string' && value !== '') argv.push(value);
	}
	for (const spec of descriptor.params) {
		if (spec.kind === 'positional') continue;
		const value = values[spec.flag];
		if (spec.kind === 'boolean') {
			if (value === true) argv.push(spec.flag);
			continue;
		}
		let rendered: string;
		if (spec.kind === 'stringList') {
			if (!Array.isArray(value) || value.length === 0) continue;
			rendered = value.join(spec.separator);
		} else {
			// 数值 0 是合法取值，只有 undefined 与空串才跳过
			if (value === undefined || value === '') continue;
			rendered = String(value);
		}
		if (descriptor.style === 'equals') argv.push(`${spec.flag}=${rendered}`);
		else argv.push(spec.flag, rendered);
	}
	return argv;
}

/** 校验表单值，返回错误信息数组；空数组表示通过 */
export function validateValues(descriptor: TaskDescriptor, values: Record<string, ParamValue>): string[] {
	const errors: string[] = [];
	for (const spec of descriptor.params) {
		if (spec.kind === 'positional') {
			const value = values[spec.name];
			if (spec.required && (typeof value !== 'string' || value === '')) {
				errors.push(`${spec.label}不能为空`);
			}
			continue;
		}
		const value = values[spec.flag];
		if (spec.kind === 'enum' && typeof value === 'string' && value !== '') {
			if (!spec.options.some((option) => option.value === value)) {
				errors.push(`${spec.flag} 的取值 ${value} 不在允许范围内`);
			}
		}
		if (spec.kind === 'number' && value !== undefined && value !== '') {
			const num = Number(value);
			if (!Number.isFinite(num)) {
				errors.push(`${spec.flag} 必须是数字`);
			} else if (spec.min !== undefined && num < spec.min) {
				errors.push(`${spec.flag} 不能小于 ${spec.min}`);
			} else if (spec.max !== undefined && num > spec.max) {
				errors.push(`${spec.flag} 不能大于 ${spec.max}`);
			}
		}
	}
	return errors;
}
