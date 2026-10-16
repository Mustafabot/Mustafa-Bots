// 通用参数表单：按任务描述符的 params 逐个渲染控件。
// values 的键就是 flag（位置参数用 name），与服务端 POST /api/task 的 values 一一对应。
import type { AnySpec, ParamValue, TaskDescriptor } from '../types';

interface ParamFormProps {
	spec: TaskDescriptor;
	values: Record<string, ParamValue>;
	onChange: (values: Record<string, ParamValue>) => void;
	/** 有任务在跑时禁用整张表单 */
	disabled?: boolean;
}

/** 取一个参数在 values 里的键：位置参数用 name，其余用 flag */
function specKey(spec: AnySpec): string {
	return spec.kind === 'positional' ? spec.name : spec.flag;
}

/** 只给单个键赋新值，其余原样保留 */
function setKey(values: Record<string, ParamValue>, key: string, value: ParamValue): Record<string, ParamValue> {
	return { ...values, [key]: value };
}

/** stringList 在文本框里以 separator 相连，回车换行也算分隔符 */
function parseList(text: string, separator: string): string[] {
	return text
		.split(new RegExp(`[${separator}\\r\\n]`))
		.map((item) => item.trim())
		.filter((item) => item !== '');
}

/** 渲染一个参数的控件与标签 */
function renderField(spec: AnySpec, values: Record<string, ParamValue>, onChange: (values: Record<string, ParamValue>) => void, disabled: boolean): React.JSX.Element {
	const key = specKey(spec);
	const value = values[key];
	const id = `param-${key.replace(/^-+/, '')}`;
	const danger = 'danger' in spec && spec.danger === true;

	let control: React.JSX.Element;
	if (spec.kind === 'boolean') {
		control = <input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(setKey(values, key, event.target.checked))} />;
	} else if (spec.kind === 'number') {
		control = (
			<input
				id={id}
				type="number"
				value={value === undefined || value === '' ? '' : Number(value)}
				min={spec.min}
				max={spec.max}
				disabled={disabled}
				onChange={(event) => onChange(setKey(values, key, event.target.value === '' ? '' : Number(event.target.value)))}
			/>
		);
	} else if (spec.kind === 'enum') {
		control = (
			<select id={id} value={typeof value === 'string' ? value : spec.default} disabled={disabled} onChange={(event) => onChange(setKey(values, key, event.target.value))}>
				{spec.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		);
	} else if (spec.kind === 'stringList') {
		const text = Array.isArray(value) ? value.join(spec.separator) : '';
		control = (
			<input
				id={id}
				type="text"
				value={text}
				placeholder={spec.description ?? `以「${spec.separator}」分隔`}
				disabled={disabled}
				onChange={(event) => onChange(setKey(values, key, parseList(event.target.value, spec.separator)))}
			/>
		);
	} else {
		// string 与 positiona：都用单行文本框
		control = (
			<input
				id={id}
				type="text"
				value={typeof value === 'string' ? value : ''}
				placeholder={spec.kind === 'string' ? spec.placeholder : undefined}
				disabled={disabled}
				onChange={(event) => onChange(setKey(values, key, event.target.value))}
			/>
		);
	}

	return (
		<div className={`field${danger ? ' field-danger' : ''}`} key={key}>
			<label htmlFor={id}>
				{spec.label}
				{spec.kind !== 'positional' && <code>{spec.flag}</code>}
			</label>
			{control}
			{spec.description !== undefined && <p className="hint">{spec.description}</p>}
			{danger && <p className="hint danger">危险参数，请确认后再使用。</p>}
		</div>
	);
}

/** 参数表单：遍历描述符的 params，逐个渲染控件 */
export function ParamForm({ spec, values, onChange, disabled = false }: ParamFormProps): React.JSX.Element {
	return (
		<div className="param-form">
			{spec.params.length === 0 && <p className="hint">该任务没有可配置参数。</p>}
			{spec.params.map((param) => renderField(param, values, onChange, disabled))}
		</div>
	);
}
