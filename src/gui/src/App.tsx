import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { LoginForm } from './components/LoginForm';
import { RunPage } from './pages/RunPage';
import { TaskList } from './pages/TaskList';

type Route = { name: 'list' } | { name: 'task'; id: string } | { name: 'history' };

/** 登录门状态：探测中 / 已认证 / 需登录 / 连不上服务 */
type Gate = 'checking' | 'authed' | 'login' | 'offline';

function parseHash(): Route {
	const hash = window.location.hash.replace(/^#/, '');
	if (hash.startsWith('/task/')) return { name: 'task', id: decodeURIComponent(hash.slice('/task/'.length)) };
	if (hash.startsWith('/history')) return { name: 'history' };
	return { name: 'list' };
}

export function App(): React.JSX.Element {
	const [route, setRoute] = useState<Route>(parseHash);
	const [gate, setGate] = useState<Gate>('checking');

	useEffect(() => {
		const onHash = () => setRoute(parseHash());
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

	if (gate === 'checking') return <main className="app">正在连接…</main>;
	if (gate === 'offline') return <main className="app">无法连接 GUI 服务，请确认 npm run gui 已启动。</main>;
	if (gate === 'login') return <LoginForm onDone={() => setGate('authed')} />;

	return (
		<main className="app">
			<header className="topbar">
				<h1>机器人控制台</h1>
				<nav>
					<a href="#/">任务</a>
					<a href="#/history">历史</a>
				</nav>
			</header>
			{route.name === 'list' && <TaskList />}
			{route.name === 'task' && <RunPage id={route.id} />}
			{route.name === 'history' && <p className="hint">历史页将在后续任务填入。</p>}
		</main>
	);
}
