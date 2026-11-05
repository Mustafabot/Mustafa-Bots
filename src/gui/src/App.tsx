import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { Icon, type IconName } from './components/Icon';
import { LoginForm } from './components/LoginForm';
import { FileRestorePage } from './pages/FileRestorePage';
import { HistoryPage } from './pages/HistoryPage';
import { LinkReplacePage } from './pages/LinkReplacePage';
import { RunPage } from './pages/RunPage';
import { TaskList } from './pages/TaskList';
import { TextReplacePage } from './pages/TextReplacePage';
import { UploadPage } from './pages/UploadPage';

type Route = { name: 'list' } | { name: 'task'; id: string } | { name: 'text-replace' } | { name: 'url-upload' } | { name: 'file-restore' } | { name: 'link-replace' } | { name: 'history' };

/** 登录门状态：探测中 / 已认证 / 需登录 / 连不上服务 */
type Gate = 'checking' | 'authed' | 'login' | 'offline';

/** 侧边栏导航分组；hash 与路由名同一份映射，避免两处各写一套 */
const NAV: ReadonlyArray<{ title: string; items: ReadonlyArray<{ route: Route['name']; label: string; href: string; icon: IconName }> }> = [
	{
		title: '工作台',
		items: [{ route: 'list', label: '任务台', href: '#/', icon: 'grid' }],
	},
	{
		title: '批量作业',
		items: [
			{ route: 'text-replace', label: '文本替换', href: '#/text-replace', icon: 'type' },
			{ route: 'link-replace', label: '链接替换', href: '#/link-replace', icon: 'link' },
			{ route: 'url-upload', label: 'URL 上传', href: '#/url-upload', icon: 'upload' },
			{ route: 'file-restore', label: '文件还原', href: '#/file-restore', icon: 'rotate' },
		],
	},
	{
		title: '记录',
		items: [{ route: 'history', label: '历史记录', href: '#/history', icon: 'history' }],
	},
];

/** 每个路由在顶栏显示的归属与标题 */
const PAGE_META: Record<Route['name'], { group: string; title: string; description: string }> = {
	list: { group: '工作台', title: '任务台', description: '所有任务在本机以子进程运行，同一时间只允许一个。' },
	task: { group: '工作台', title: '任务运行', description: '配置参数、启动任务，实时查看进度与输出。' },
	'text-replace': { group: '批量作业', title: '文本替换', description: '在本地镜像中检索并逐页替换，带冲突检测与断点。' },
	'link-replace': { group: '批量作业', title: '链接替换', description: '按规则重写内链、文件链接与模板参数。' },
	'url-upload': { group: '批量作业', title: 'URL 上传', description: '批量上传外站图片或本机文件到共享站。' },
	'file-restore': { group: '批量作业', title: '文件还原', description: '按队列页恢复被删除的文件并撤销多余编辑。' },
	history: { group: '记录', title: '历史记录', description: '过往任务的逐页改动与行级差异。' },
};

function parseHash(): Route {
	const hash = window.location.hash.replace(/^#/, '');
	if (hash.startsWith('/task/')) return { name: 'task', id: decodeURIComponent(hash.slice('/task/'.length)) };
	if (hash.startsWith('/text-replace')) return { name: 'text-replace' };
	if (hash.startsWith('/url-upload')) return { name: 'url-upload' };
	if (hash.startsWith('/file-restore')) return { name: 'file-restore' };
	if (hash.startsWith('/link-replace')) return { name: 'link-replace' };
	if (hash.startsWith('/history')) return { name: 'history' };
	return { name: 'list' };
}

/** 当前路由落在哪个导航项上：任务详情页归入任务台 */
function activeRoute(route: Route): Route['name'] {
	return route.name === 'task' ? 'list' : route.name;
}

/** 品牌标识：侧栏与登录页共用 */
function Brand(): React.JSX.Element {
	return (
		<span className="brand">
			<span className="brand-mark">
				<Icon name="bot" size={22} />
			</span>
			<span className="brand-text">
				<strong>MustafaKemalBot</strong>
				<small>萌娘百科 · 控制台</small>
			</span>
		</span>
	);
}

export function App(): React.JSX.Element {
	const [route, setRoute] = useState<Route>(parseHash);
	const [gate, setGate] = useState<Gate>('checking');

	useEffect(() => {
		const onHash = () => {
			setRoute(parseHash());
			// 换页回到顶部：长页面之间跳转时不保留上一页的滚动位置
			window.scrollTo({ top: 0 });
		};
		window.addEventListener('hashchange', onHash);
		return () => window.removeEventListener('hashchange', onHash);
	}, []);

	useEffect(() => {
		// 探测登录态，分三种结果：
		// - 401：口令模式未登录，出登录框
		// - 其它 ApiError：无口令模式或已登录，直达主界面
		// - 非 ApiError（fetch 本身失败）：服务没起或断网，显示无法连接，而不是让页面看着能用却处处报错
		api.task
			.get()
			.then(() => setGate('authed'))
			.catch((error: unknown) => {
				if (!(error instanceof ApiError)) setGate('offline');
				else setGate(error.status === 401 ? 'login' : 'authed');
			});
	}, []);

	if (gate === 'checking') {
		return (
			<main className="auth-screen">
				<section className="auth-card auth-status">
					<span className="spinner" aria-hidden="true" />
					<h1>正在连接控制台…</h1>
					<p className="hint">探测本机 GUI 服务。</p>
				</section>
			</main>
		);
	}

	if (gate === 'offline') {
		return (
			<main className="auth-screen">
				<section className="auth-card auth-status">
					<span className="auth-icon auth-icon-danger">
						<Icon name="alert" size={24} />
					</span>
					<h1>连接不上 GUI 服务</h1>
					<p className="hint">请确认服务已启动，然后刷新本页。</p>
					<code className="offline-code">npm run gui</code>
				</section>
			</main>
		);
	}

	if (gate === 'login') return <LoginForm onDone={() => setGate('authed')} />;

	const meta = PAGE_META[route.name];
	const current = activeRoute(route);

	return (
		<main className="shell">
			<aside className="sidebar">
				<a className="brand-link" href="#/" aria-label="回到任务台">
					<Brand />
				</a>
				<nav className="nav" aria-label="主导航">
					{NAV.map((group) => (
						<div className="nav-group" key={group.title}>
							<p className="nav-title">{group.title}</p>
							{group.items.map((item) => (
								<a key={item.route} className={`nav-item${current === item.route ? ' active' : ''}`} href={item.href} aria-current={current === item.route ? 'page' : undefined}>
									<Icon name={item.icon} size={17} />
									<span>{item.label}</span>
								</a>
							))}
						</div>
					))}
				</nav>
				<div className="sidebar-foot">
					<div className="service">
						<span className="service-dot" aria-hidden="true" />
						<span className="service-copy">
							<strong>本地服务在线</strong>
							<small className="mono">{window.location.host}</small>
						</span>
					</div>
					<p className="sidebar-note">单任务锁 · 关服务会中止任务</p>
				</div>
			</aside>

			<div className="main">
				<header className="topbar">
					<div className="topbar-title">
						<span className="eyebrow">{meta.group}</span>
						<h1>{meta.title}</h1>
						<p className="topbar-sub">{meta.description}</p>
					</div>
					<div className="topbar-meta">
						<span className="chip">
							<span className="chip-dot" aria-hidden="true" />
							本地运行
						</span>
						<span className="chip mono">{window.location.host}</span>
					</div>
				</header>

				<div className="content">
					{route.name === 'list' && <TaskList />}
					{route.name === 'task' && <RunPage id={route.id} />}
					{route.name === 'text-replace' && <TextReplacePage />}
					{route.name === 'url-upload' && <UploadPage />}
					{route.name === 'file-restore' && <FileRestorePage />}
					{route.name === 'link-replace' && <LinkReplacePage />}
					{route.name === 'history' && <HistoryPage />}
				</div>
			</div>
		</main>
	);
}
