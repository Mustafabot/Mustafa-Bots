import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESCRIPTORS, findDescriptor } from '../core/registry.js';
import { issueToken, verifyPassword, type ServerConfig } from './auth.js';
import { HistoryStore } from './history.js';
import { RulesetPublisher, RulesetStore } from './rulesets.js';
import { TaskRunner } from './taskRunner.js';

// fileURLToPath 对以 / 结尾的 URL 会保留尾部路径分隔符，必须先 resolve 归一化，
// 否则下面 `PUBLIC_DIR + sep` 会成为双分隔符前缀，把正常文件也判成越界。
const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public/', import.meta.url)));

export function createRouter(config: ServerConfig) {
	const runner = new TaskRunner();
	const history = new HistoryStore('data/gui/history.db');
	const rulesets = new RulesetStore('data/gui/rulesets');
	const publisher = new RulesetPublisher(rulesets);
	const pendingParams = new Map<string, Record<string, unknown>>();
	// 会话集合必须活在 createRouter 作用域：若放进请求回调，每次请求都会得到空集，
	// 登录换来的 cookie 在下一个请求就失效。
	const sessions = new Set<string>();
	const authRequired = config.password !== undefined;

	return (req: IncomingMessage, res: ServerResponse): void => {
		// 整段分派包进 try/catch：畸形 Host 头等会让 new URL 抛错，
		// 未捕获的异常会终结整个服务进程，这里降级为 400。
		try {
			const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

			const cookies = parseCookies(req.headers.cookie);
			const authed = !authRequired || (cookies.gui_session !== undefined && sessions.has(cookies.gui_session));

			if (url.pathname === '/api/auth/login' && req.method === 'POST') {
				readBody(req).then((body) => {
					try {
						const { password } = JSON.parse(body || '{}') as { password?: string };
						if (!authRequired || verifyPassword(password ?? '', config.password!)) {
							const token = issueToken();
							sessions.add(token);
							res.writeHead(200, {
								'content-type': 'application/json; charset=utf-8',
								'set-cookie': `gui_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
							});
							res.end('{"ok":true}');
							return;
						}
						sendJson(res, 401, { error: '口令不正确' });
					} catch (error) {
						sendJson(res, 400, { error: (error as Error).message });
					}
				});
				return;
			}

			if (url.pathname.startsWith('/api/') && !authed) {
				sendJson(res, 401, { error: '未登录' });
				return;
			}

			if (url.pathname === '/api/descriptors') {
				sendJson(res, 200, { descriptors: DESCRIPTORS });
				return;
			}

			if (url.pathname === '/api/task' && req.method === 'GET') {
				sendJson(res, 200, { task: runner.current });
				return;
			}

			if (url.pathname === '/api/task' && req.method === 'POST') {
				readBody(req).then((body) => {
					try {
						const { descriptorId, values, rulesetName } = JSON.parse(body || '{}') as {
							descriptorId: string;
							values: Record<string, string | number | boolean | string[]>;
							rulesetName?: string;
						};
						const descriptor = findDescriptor(descriptorId);
						if (!descriptor) throw new Error(`未知任务 ${descriptorId}`);
						const injected: string[] = [];
						if (descriptor.rulesetFlag) {
							if (!rulesetName) throw new Error('该任务必须先选择规则集');
							const draft = rulesets.read(rulesetName);
							if (!draft) throw new Error(`规则集 "${rulesetName}" 没有本地草稿`);
							const tempFile = resolve('data/gui/runtime', `${rulesetName}-${Date.now()}.json`);
							mkdirSync(dirname(tempFile), { recursive: true });
							writeFileSync(tempFile, draft.content, 'utf-8');
							injected.push(descriptor.rulesetFlag, tempFile);
						}
						const record = runner.start(descriptor, values, injected);
						pendingParams.set(record.id, values ?? {});
						runner.once('finish', () => history.saveTask(record, pendingParams.get(record.id) ?? {}));
						sendJson(res, 200, { task: record });
					} catch (error) {
						sendJson(res, 409, { error: (error as Error).message });
					}
				});
				return;
			}

			if (url.pathname === '/api/task/abort' && req.method === 'POST') {
				const aborted = runner.abort();
				sendJson(res, aborted ? 200 : 409, { ok: aborted });
				return;
			}

			if (url.pathname === '/api/task/events') {
				res.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-cache',
					connection: 'keep-alive',
				});
				const send = (task: unknown, event: unknown) => {
					res.write(`data: ${JSON.stringify({ task, event })}\n\n`);
				};
				// 先回放已发生的事件：任务状态存在服务端，断线重连或刷新后仍能补齐历史
				for (const event of runner.current?.events ?? []) send(runner.current, event);
				const unsubscribe = runner.subscribe(send);
				const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
				req.on('close', () => {
					clearInterval(keepAlive);
					unsubscribe();
				});
				return;
			}

			if (url.pathname === '/api/history' && req.method === 'GET') {
				sendJson(res, 200, { tasks: history.listTasks() });
				return;
			}

			const historyMatch = /^\/api\/history\/(.+)$/.exec(url.pathname);
			if (historyMatch) {
				const detail = history.getTask(decodeURIComponent(historyMatch[1]));
				if (!detail) {
					sendJson(res, 404, { error: '任务不存在' });
					return;
				}
				sendJson(res, 200, detail);
				return;
			}

			if (url.pathname === '/api/rulesets' && req.method === 'GET') {
				sendJson(res, 200, { rulesets: rulesets.list() });
				return;
			}

			const rulesetMatch = /^\/api\/rulesets\/([^/]+)(\/publish)?$/.exec(url.pathname);
			if (rulesetMatch) {
				const name = decodeURIComponent(rulesetMatch[1]);
				if (rulesetMatch[2] === '/publish' && req.method === 'POST') {
					publisher
						.publish(name)
						.then((result) => sendJson(res, result.ok ? 200 : 409, result))
						.catch((error: Error) => sendJson(res, 500, { error: error.message }));
					return;
				}
				if (req.method === 'GET') {
					const draft = rulesets.read(name);
					publisher
						.fetchRemote(name)
						.then((remote) => sendJson(res, 200, { draft, remote }))
						.catch((error: Error) => sendJson(res, 500, { error: error.message }));
					return;
				}
				if (req.method === 'PUT') {
					readBody(req).then((body) => {
						try {
							const { content } = JSON.parse(body || '{}') as { content: string };
							const existing = rulesets.read(name);
							sendJson(res, 200, { draft: rulesets.write(name, content, existing?.baseRevid ?? null) });
						} catch (error) {
							sendJson(res, 400, { error: (error as Error).message });
						}
					});
					return;
				}
			}

			serveStatic(url.pathname, res);
		} catch (error) {
			sendJson(res, 400, { error: (error as Error).message });
		}
	};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function parseCookies(header: string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const pair of (header ?? '').split(';')) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}
	return result;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}

function serveStatic(pathname: string, res: ServerResponse): void {
	const name = pathname === '/' ? 'index.html' : pathname.slice(1);
	// 绝对形式请求（如 `GET http://主机//etc/passwd`）会让 pathname 成为 `//etc/passwd`，
	// slice 后 name 以 `/` 开头；resolve 会把它当绝对路径从而逃出 public 目录，必须直接拒绝。
	if (name.startsWith('/')) {
		res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('禁止访问');
		return;
	}
	const target = resolve(PUBLIC_DIR, name);
	// 兜底校验：解析结果必须仍位于 public 目录内（`..` 等穿越同样在此被挡下）
	if (!target.startsWith(PUBLIC_DIR + sep)) {
		res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('禁止访问');
		return;
	}
	try {
		const body = readFileSync(target);
		const type = extname(name) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
		res.writeHead(200, { 'content-type': type });
		res.end(body);
	} catch {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('未找到');
	}
}
