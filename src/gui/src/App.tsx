import { useEffect, useState } from 'react';

type Route = { name: 'list' } | { name: 'task'; id: string } | { name: 'history' };

function parseHash(): Route {
	const hash = window.location.hash.replace(/^#/, '');
	if (hash.startsWith('/task/')) return { name: 'task', id: decodeURIComponent(hash.slice('/task/'.length)) };
	if (hash.startsWith('/history')) return { name: 'history' };
	return { name: 'list' };
}

export function App(): React.JSX.Element {
	const [route, setRoute] = useState<Route>(parseHash);
	useEffect(() => {
		const onHash = () => setRoute(parseHash());
		window.addEventListener('hashchange', onHash);
		return () => window.removeEventListener('hashchange', onHash);
	}, []);
	return (
		<main className="app">
			<h1>机器人控制台</h1>
			<p>页面骨架（任务列表 / 任务页 / 历史页）将在后续任务填入。</p>
			<p>当前路由：{JSON.stringify(route)}</p>
		</main>
	);
}
