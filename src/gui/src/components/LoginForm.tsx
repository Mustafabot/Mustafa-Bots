import { useState } from 'react';
import { ApiError, api } from '../api';
import { Icon } from './Icon';

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
		<main className="auth-screen">
			<section className="auth-card">
				<div className="brand brand-auth">
					<span className="brand-mark">
						<Icon name="bot" size={24} />
					</span>
					<span className="brand-text">
						<strong>MustafaKemalBot</strong>
						<small>萌娘百科 · 控制台</small>
					</span>
				</div>
				<h1>口令登录</h1>
				<p className="hint">该实例启用了访问口令，输入后进入控制台。</p>
				<form className="login" onSubmit={submit}>
					<label htmlFor="gui-password">访问口令</label>
					<input id="gui-password" type="password" value={password} autoFocus placeholder="GUI_PASSWORD" onChange={(event) => setPassword(event.target.value)} />
					<button type="submit" className="primary" disabled={busy}>
						{busy ? '登录中…' : '进入控制台'}
						<Icon name="arrowRight" size={15} />
					</button>
					{error !== null && <p className="error">{error}</p>}
				</form>
			</section>
			<p className="auth-foot">MustafaKemalBot · 本地运行，凭据不离开本机</p>
		</main>
	);
}
