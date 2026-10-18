// 分类输入：回车添加、点标签删除，输入时给共享站的分类补全建议。
// 与共享站 Widget:Uploader 的观感一致——这一个字段对整批文件生效。
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface CategoryInputProps {
	categories: string[];
	onChange: (categories: string[]) => void;
	disabled?: boolean;
}

/** 输入停顿多久才去查补全 */
const DEBOUNCE_MS = 200;

/** 分类输入 */
export function CategoryInput({ categories, onChange, disabled = false }: CategoryInputProps): React.JSX.Element {
	const [text, setText] = useState('');
	const [hints, setHints] = useState<string[]>([]);
	const timerRef = useRef<number | null>(null);

	// 输入变化后延迟查补全；组件卸载或再次输入时清掉上一个定时器
	useEffect(() => {
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		if (text.trim() === '') {
			setHints([]);
			return;
		}
		timerRef.current = window.setTimeout(() => {
			api.categories(text.trim())
				.then((result) => setHints(result.categories.filter((name) => !categories.includes(name))))
				.catch(() => setHints([]));
		}, DEBOUNCE_MS);
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, [text, categories]);

	const add = (name: string): void => {
		const trimmed = name.trim();
		if (trimmed === '' || categories.includes(trimmed)) return;
		onChange([...categories, trimmed]);
		setText('');
		setHints([]);
	};

	return (
		<div className="category-input">
			<div className="field">
				<label htmlFor="upload-category">分类</label>
				<input
					id="upload-category"
					type="text"
					value={text}
					placeholder="输入后按回车添加，整批共享"
					disabled={disabled}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							add(text);
						}
					}}
				/>
			</div>
			{hints.length > 0 && (
				<div className="category-hints">
					{hints.map((hint) => (
						<button type="button" key={hint} disabled={disabled} onClick={() => add(hint)}>
							{hint}
						</button>
					))}
				</div>
			)}
			<div className="categories">
				{categories.map((name) => (
					<button type="button" className="category-tag" key={name} title="点击删除" disabled={disabled} onClick={() => onChange(categories.filter((item) => item !== name))}>
						{name} ×
					</button>
				))}
			</div>
		</div>
	);
}
