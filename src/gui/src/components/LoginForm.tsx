import { useState } from 'react';
import { ApiError, api } from '../api';

/** 登录门：口令模式下的口令输入，登录成功后回调 onDone 放行进主界面。 */
export function LoginForm({ onDone }: { onDone: () => void }): React.JSX.Element {
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		api.login(password)
			.then(() => onDone())
			.catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : '登录失败，请重试'))
			.finally(() => setBusy(false));
	};

	return (
		<main className="app">
			<h1>机器人控制台</h1>
			<form className="login" onSubmit={submit}>
				<label htmlFor="gui-password">口令</label>
				<input id="gui-password" type="password" value={password} autoFocus onChange={(event) => setPassword(event.target.value)} />
				<button type="submit" disabled={busy}>
					{busy ? '登录中…' : '登录'}
				</button>
				{error !== null && <p className="error">{error}</p>}
			</form>
		</main>
	);
}
