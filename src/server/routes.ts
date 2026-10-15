import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateValues } from '../core/descriptor.js';
import type { ProgressEvent } from '../core/progress.js';
import { DESCRIPTORS, findDescriptor } from '../core/registry.js';
import { isLocalHeaderHost, isLocalOriginUrl, issueToken, verifyPassword, type ServerConfig } from './auth.js';
import { HistoryStore } from './history.js';
import { RulesetPublisher, RulesetStore } from './rulesets.js';
import { ScanStore } from './scans.js';
import { TaskRunner, type TaskRecord } from './taskRunner.js';

// fileURLToPath 对以 / 结尾的 URL 会保留尾部路径分隔符，必须先 resolve 归一化，
// 否则下面 `PUBLIC_DIR + sep` 会成为双分隔符前缀，把正常文件也判成越界。
const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public/', import.meta.url)));

export function createRouter(config: ServerConfig, runner: TaskRunner = new TaskRunner()) {
	const history = new HistoryStore('data/gui/history.db');
	const rulesets = new RulesetStore('data/gui/rulesets');
	const scans = new ScanStore('data/gui/scans');
	const publisher = new RulesetPublisher(rulesets);
	const pendingParams = new Map<string, Record<string, unknown>>();
	// 会话集合必须活在 createRouter 作用域：若放进请求回调，每次请求都会得到空集，
	// 登录换来的 cookie 在下一个请求就失效。
	const sessions = new Set<string>();
	const authRequired = config.password !== undefined;

	return (req: IncomingMessage, res: ServerResponse): void => {
		// 无口令模式下的 DNS 重绑定防护：恶意页面可把自己的域名解析到 127.0.0.1，
		// 再以 text/plain 发简单跨站请求（无 CORS 预检）驱动本服务真实编辑 wiki。
		// 于是无口令时要求 Host（及出现的 Origin/Referer）都指向本机；
		// 设了口令则由会话校验兜底，不限制访问来源。
		if (!authRequired) {
			const host = req.headers.host;
			const origin = req.headers.origin;
			const referer = req.headers.referer;
			if ((host !== undefined && !isLocalHeaderHost(host)) || (origin !== undefined && !isLocalOriginUrl(origin)) || (referer !== undefined && !isLocalOriginUrl(referer))) {
				sendJson(res, 403, { error: '仅接受来自本机地址的请求（Host/Origin/Referer 校验未通过）' });
				return;
			}
		}

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
						// 声明的约束（如 --days 最小值 1）必须在启动子进程前就拦下，
						// 否则非法取值会一路传到脚本里才以奇怪的方式失败
						const valueErrors = validateValues(descriptor, values ?? {});
						if (valueErrors.length > 0) {
							sendJson(res, 400, { error: `参数校验失败：${valueErrors.join('；')}` });
							return;
						}
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
						// GUI 拉起的任务一律静默：逐页人类可读日志既刷屏，
						// 又会挤占事件缓冲的名额，结构化事件里已带全部信息
						injected.push(descriptor.quietFlag);
						const record = runner.start(descriptor, values, injected);
						pendingParams.set(record.id, values ?? {});
						runner.once('finish', () => {
							// 落库失败（例如双开实例时的 SQLITE_BUSY）不能让异常冒到
							// EventEmitter 之外终结进程
							try {
								history.saveTask(record, pendingParams.get(record.id) ?? {});
							} catch (error) {
								console.error(`历史落库失败: ${(error as Error).message}`);
							}
						});
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
				// 客户端可能中途断开：不挂 error 处理会让 write 抛出的 EPIPE
				// 变成未捕获的 'error' 事件，直接把整个服务进程带下去
				res.on('error', () => {});
				const send = (task: TaskRecord, event: ProgressEvent) => {
					// 每帧只带任务元信息，不带 events 数组：事件本来就逐条下发，
					// 把整段历史随每帧重发一遍，帧体会随事件数线性膨胀（整体 O(n²)）。
					// 浅拷贝去掉 events，其余字段原样保留。
					const { events, ...taskMeta } = task;
					void events;
					res.write(`data: ${JSON.stringify({ task: taskMeta, event })}\n\n`);
				};
				// 先回放已发生的事件：任务状态存在服务端，断线重连或刷新后仍能补齐历史
				const current = runner.current;
				if (current) for (const event of current.events) send(current, event);
				const unsubscribe = runner.subscribe(send);
				const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
				req.on('close', () => {
					clearInterval(keepAlive);
					unsubscribe();
				});
				return;
			}

			if (url.pathname === '/api/scans' && req.method === 'GET') {
				sendJson(res, 200, { scans: scans.list() });
				return;
			}

			const scanMatch = /^\/api\/scans\/([^/]+)$/.exec(url.pathname);
			if (scanMatch && req.method === 'GET') {
				const rawOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
				const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
				const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
				// 上限 1000：一次拖走上万条命中会把响应体撑到几十 MB
				const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200;
				const slice = scans.page(decodeURIComponent(scanMatch[1]), offset, limit);
				if (!slice) {
					sendJson(res, 404, { error: '扫描结果不存在' });
					return;
				}
				sendJson(res, 200, slice);
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
							const { content } = JSON.parse(body || '{}') as { content?: string };
							// content 不是字符串（含空 body、上传中断被 readBody 兜底成 ''）时必须拒绝：
							// 直接写盘会把已存草稿覆盖成没有正文的残骸，而 200 会让调用方毫无察觉
							if (typeof content !== 'string') {
								sendJson(res, 400, { error: '请求体缺少字符串字段 content，已取消保存' });
								return;
							}
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
	// 出错也要 resolve：请求流出错（客户端中途断开等）时若 reject，
	// 调用方 .then 无 .catch 就会变成未处理的 Promise 拒绝，Node ≥15 下直接终结进程
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', () => resolve(''));
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
