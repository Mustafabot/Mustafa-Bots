import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { LoginForm } from './components/LoginForm';

type Route = { name: 'list' } | { name: 'task'; id: string } | { name: 'history' };

function parseHash(): Route {
	const hash = window.location.hash.replace(/^#/, '');
	if (hash.startsWith('/task/')) return { name: 'task', id: decodeURIComponent(hash.slice('/task/'.length)) };
	if (hash.startsWith('/history')) return { name: 'history' };
	return { name: 'list' };
}

export function App(): React.JSX.Element {
	const [route, setRoute] = useState<Route>(parseHash);
	const [authed, setAuthed] = useState<boolean | null>(null);

	useEffect(() => {
		const onHash = () => setRoute(parseHash());
		window.addEventListener('hashchange', onHash);
		return () => window.removeEventListener('hashchange', onHash);
	}, []);

	useEffect(() => {
		// 探测登录态：口令模式下未登录会 401，据此显示登录框；
		// 无口令模式下该请求不会 401，自然直达主界面。
		api.task
			.get()
			.then(() => setAuthed(true))
			.catch((error: unknown) => setAuthed(error instanceof ApiError && error.status === 401 ? false : true));
	}, []);

	if (authed === null) return <main className="app">正在连接…</main>;
	if (!authed) return <LoginForm onDone={() => setAuthed(true)} />;

	return (
		<main className="app">
			<h1>机器人控制台</h1>
			<p>页面骨架（任务列表 / 任务页 / 历史页）将在后续任务填入。</p>
			<p>当前路由：{JSON.stringify(route)}</p>
		</main>
	);
}
