// 内联矢量图标：不引第三方图标依赖，统一 24 网格、1.7 描边、圆角端点。
// 图标只作结构语义使用（禁止 emoji），尺寸由 size 控制，颜色继承 currentColor。

export type IconName =
	| 'bot'
	| 'grid'
	| 'type'
	| 'link'
	| 'upload'
	| 'rotate'
	| 'history'
	| 'arrowLeft'
	| 'arrowRight'
	| 'play'
	| 'stop'
	| 'terminal'
	| 'activity'
	| 'check'
	| 'alert'
	| 'clock'
	| 'copy'
	| 'trash'
	| 'shield'
	| 'file'
	| 'spark';

const PATHS: Record<IconName, React.ReactNode> = {
	bot: (
		<>
			<rect x="4" y="8" width="16" height="12" rx="3" />
			<path d="M12 8V5" />
			<circle cx="12" cy="3.5" r="1.2" />
			<path d="M9 13h.01M15 13h.01" />
			<path d="M9.5 16.5h5" />
		</>
	),
	grid: (
		<>
			<rect x="3.5" y="3.5" width="7" height="7" rx="2" />
			<rect x="13.5" y="3.5" width="7" height="7" rx="2" />
			<rect x="3.5" y="13.5" width="7" height="7" rx="2" />
			<rect x="13.5" y="13.5" width="7" height="7" rx="2" />
		</>
	),
	type: (
		<>
			<path d="M4 6.5V5h16v1.5" />
			<path d="M12 5v14" />
			<path d="M8.5 19h7" />
		</>
	),
	link: (
		<>
			<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7L11.5 6.3" />
			<path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.1-1.1" />
		</>
	),
	upload: (
		<>
			<path d="M12 16V4" />
			<path d="m7 9 5-5 5 5" />
			<path d="M5 20h14" />
		</>
	),
	rotate: (
		<>
			<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3" />
			<path d="M3.5 4.5V10H9" />
			<path d="M12 8v4.5l3 1.8" />
		</>
	),
	history: (
		<>
			<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
			<path d="M3.5 4.5V10H9" />
			<path d="M12 7.5V12l3.2 1.9" />
		</>
	),
	arrowLeft: (
		<>
			<path d="M19 12H5" />
			<path d="m11 18-6-6 6-6" />
		</>
	),
	arrowRight: (
		<>
			<path d="M5 12h14" />
			<path d="m13 6 6 6-6 6" />
		</>
	),
	play: <path d="M8 5.5v13l10-6.5z" />,
	stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
	terminal: (
		<>
			<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
			<path d="m7.5 9.5 3 2.5-3 2.5" />
			<path d="M13 15h4" />
		</>
	),
	activity: <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />,
	check: <path d="m4.5 12.5 5 5L20 6.5" />,
	alert: (
		<>
			<path d="M12 4 2.8 19.5h18.4z" />
			<path d="M12 9v4.5" />
			<path d="M12 17h.01" />
		</>
	),
	clock: (
		<>
			<circle cx="12" cy="12" r="8.5" />
			<path d="M12 7.5V12l3 1.8" />
		</>
	),
	copy: (
		<>
			<rect x="8.5" y="8.5" width="11" height="11" rx="2" />
			<path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
		</>
	),
	trash: (
		<>
			<path d="M4.5 7h15" />
			<path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7" />
			<path d="M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12" />
			<path d="M10.5 11v6M13.5 11v6" />
		</>
	),
	shield: (
		<>
			<path d="M12 3.5 5 6.2v5.1c0 4.3 3 7.5 7 9.2 4-1.7 7-4.9 7-9.2V6.2z" />
			<path d="m9 12 2.2 2.2L15.5 10" />
		</>
	),
	file: (
		<>
			<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
			<path d="M14 3.5V8h4.5" />
		</>
	),
	spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />,
};

/** 统一图标组件；装饰性图标对读屏隐藏 */
export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }): React.JSX.Element {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.7}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{PATHS[name]}
		</svg>
	);
}
