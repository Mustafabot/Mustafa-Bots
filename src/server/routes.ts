import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateValues } from '../core/descriptor.js';
import type { ProgressEvent } from '../core/progress.js';
import { DESCRIPTORS, findDescriptor } from '../core/registry.js';
import { QUEUE_PAGE, parseQueue, renderQueue } from '../restore/queueFormat.js';
import { isLocalHeaderHost, isLocalOriginUrl, issueToken, verifyPassword, type ServerConfig } from './auth.js';
import { CategoryService } from './categories.js';
import { TextDraftStore } from './drafts.js';
import { HistoryStore } from './history.js';
import { NamespaceService } from './namespaces.js';
import { parsePageSaveRequest } from './pageSaveRequest.js';
import { PageTextService } from './pageText.js';
import { readPage, writePage } from './pageWrite.js';
import { parseQueueSaveRequest } from './queueRequest.js';
import { RulesetPublisher, RulesetStore, draftBaseline, pageTitleFor, resolveRunRuleset, type RunRuleset } from './rulesets.js';
import { ScanStore } from './scans.js';
import { getSession } from './session.js';
import { TaskRunner, type TaskRecord } from './taskRunner.js';
import { clearUploads, listUploads, receiveUpload, resolveUpload } from './uploads.js';

// fileURLToPath 对以 / 结尾的 URL 会保留尾部路径分隔符，必须先 resolve 归一化，
// 否则下面 `PUBLIC_DIR + sep` 会成为双分隔符前缀，把正常文件也判成越界。
const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public/', import.meta.url)));

export function createRouter(config: ServerConfig, runner: TaskRunner = new TaskRunner()) {
	const history = new HistoryStore('data/gui/history.db');
	const rulesets = new RulesetStore('data/gui/rulesets');
	const uploadTasks = new TextDraftStore('data/gui/upload-tasks');
	const scans = new ScanStore('data/gui/scans');
	const namespaces = new NamespaceService();
	const categories = new CategoryService();
	const pageText = new PageTextService();
	const publisher = new RulesetPublisher(rulesets);
	// 描述符给的短名 → 草稿库；白名单化，避免描述符里的字符串直接参与路径拼接。
	// 规则集草稿比上传任务多 page 与 baseRevid 两个字段，故这里只声明用得到的 read。
	const draftStores = new Map<string, { read(name: string): { content: string } | null }>([
		['rulesets', rulesets],
		['upload-tasks', uploadTasks],
		['link-configs', new TextDraftStore('data/gui/link-configs')],
	]);
	const draftStoreFor = (source: string | undefined): { read(name: string): { content: string } | null } => {
		const key = source ?? 'rulesets';
		const store = draftStores.get(key);
		if (store === undefined) throw new Error(`未知的配置来源：${key}`);
		return store;
	};
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
						const { descriptorId, values, rulesetName, rulesetContent, submitTitles } = JSON.parse(body || '{}') as {
							descriptorId: string;
							values: Record<string, string | number | boolean | string[]>;
							rulesetName?: string;
							rulesetContent?: string;
							submitTitles?: string[];
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
						// 跑这次任务所用规则集的快照：历史库只存参数与页面 revid，事后回溯要知道"当时跑的是哪套规则"，
						// 故把规则原文随参数一并落库（几百字节的元数据，与"不存 diff 正文"不冲突）
						let rulesetSnapshot: RunRuleset | null = null;
						if (descriptor.configFileFlag) {
							// 仅同步镜像（--sync-only）的任务不读配置：CLI 在 sync 下不构建、不校验，
							// 因此可以两样都不带。
							const syncOnly = values?.['--sync-only'] === true;
							rulesetSnapshot = resolveRunRuleset(draftStoreFor(descriptor.configSource), { rulesetName, rulesetContent, syncOnly });
							if (rulesetSnapshot) {
								// 文件名只用时间戳：配置名可能是页面标题，带 / 与 : 会拼出非法路径
								const tempFile = resolve('data/gui/runtime', `config-${Date.now()}.json`);
								mkdirSync(dirname(tempFile), { recursive: true });
								writeFileSync(tempFile, rulesetSnapshot.content, 'utf-8');
								injected.push(descriptor.configFileFlag, tempFile);
							}
						}
						// 界面勾选的页面清单：脚本要读文件，所以由服务端落一个临时清单
						if (submitTitles !== undefined) {
							if (!Array.isArray(submitTitles) || submitTitles.length === 0) throw new Error('submitTitles 必须是非空数组');
							const titles = submitTitles.map((title) => (typeof title === 'string' ? title.trim() : '')).filter((title) => title !== '');
							if (titles.length === 0) throw new Error('submitTitles 里没有有效的页面标题');
							const selectionFile = resolve('data/gui/runtime', `selection-${Date.now()}.txt`);
							mkdirSync(dirname(selectionFile), { recursive: true });
							writeFileSync(selectionFile, `${[...new Set(titles)].join('\n')}\n`, 'utf-8');
							injected.push('--submit', selectionFile);
						}
						// GUI 拉起的任务一律静默：逐页人类可读日志既刷屏，
						// 又会挤占事件缓冲的名额，结构化事件里已带全部信息
						injected.push(descriptor.quietFlag);
						const record = runner.start(descriptor, values, injected);
						// 落库的参数额外带上规则集快照（有才带）：历史页据此还原"当时跑的是什么规则"
						pendingParams.set(record.id, rulesetSnapshot ? { ...(values ?? {}), __ruleset: rulesetSnapshot } : (values ?? {}));
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

			if (url.pathname === '/api/namespaces' && req.method === 'GET') {
				const wiki = url.searchParams.get('wiki') === 'cm' ? 'cm' : 'zh';
				namespaces
					.list(wiki)
					.then((result) => sendJson(res, 200, result))
					.catch((error: Error) => sendJson(res, 500, { error: error.message }));
				return;
			}

			if (url.pathname === '/api/categories' && req.method === 'GET') {
				categories
					.search(url.searchParams.get('prefix') ?? '')
					.then((list) => sendJson(res, 200, { categories: list }))
					.catch((error: Error) => sendJson(res, 500, { error: error.message }));
				return;
			}

			// ── 上传用的本机文件暂存 ──
			// 先给清理按钮一个问路的口子：它要告诉用户"将删掉几个文件、多大空间"
			if (url.pathname === '/api/uploads' && req.method === 'GET') {
				sendJson(res, 200, listUploads());
				return;
			}

			if (url.pathname === '/api/uploads' && req.method === 'POST') {
				let name: string;
				try {
					name = (url.searchParams.get('name') ?? '').trim();
					if (name === '') throw new Error('缺少 name 查询参数');
				} catch (error) {
					sendJson(res, 400, { error: (error as Error).message });
					return;
				}
				// 请求体是文件原始字节：原生 http 下这样最省事，不必手写 multipart 解析
				receiveUpload(req, res, name);
				return;
			}

			// 已知边界：暂存目录按文件名存放，同一批里两张都叫 a.png 的本机文件只会留下一份
			// （后传的覆盖先传的）。界面上不做去重——用户看得见自己选了什么；真要传两张同名图，
			// 先前在文件管理器里改个名。

			if (url.pathname === '/api/uploads' && req.method === 'DELETE') {
				sendJson(res, 200, { removed: clearUploads() });
				return;
			}

			const uploadFileMatch = /^\/api\/uploads\/([^/]+)$/.exec(url.pathname);
			if (uploadFileMatch && req.method === 'GET') {
				// 预览本机图片：只认暂存目录内的文件，越界一律 404
				const file = resolveUpload(uploadFileMatch[1]);
				if (file === null) {
					sendJson(res, 404, { error: '文件不存在' });
					return;
				}
				try {
					const body = readFileSync(file);
					// 只有这几种图片按真实类型回：客户端传上来的 .html / .svg 若照扩展名回真实类型，
					// 浏览器对 /api/uploads/x.html 做顶层导航就会在 GUI 自己的源上执行其中的脚本
					// （带着 gui_session，等于同源存储型 XSS）。认不出的类型一律当二进制附件下载。
					const imageType = PREVIEW_IMAGE_TYPES[extname(file).toLowerCase()];
					const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' };
					if (imageType !== undefined) {
						headers['content-type'] = imageType;
					} else {
						headers['content-type'] = 'application/octet-stream';
						// 刻意不带 filename：文件名来自客户端，写进响应头会引入头注入面
						headers['content-disposition'] = 'attachment';
					}
					res.writeHead(200, headers);
					res.end(body);
				} catch (error) {
					sendJson(res, 404, { error: (error as Error).message });
				}
				return;
			}

			// ── 上传任务的本地草稿 ──
			if (url.pathname === '/api/upload-tasks' && req.method === 'GET') {
				sendJson(res, 200, { tasks: uploadTasks.list() });
				return;
			}

			const uploadTaskMatch = /^\/api\/upload-tasks\/([^/]+)$/.exec(url.pathname);
			if (uploadTaskMatch) {
				let name: string;
				try {
					name = decodeURIComponent(uploadTaskMatch[1]);
				} catch {
					sendJson(res, 400, { error: '草稿名编码有误' });
					return;
				}
				if (req.method === 'GET') {
					try {
						sendJson(res, 200, { task: uploadTasks.read(name) });
					} catch (error) {
						sendJson(res, 400, { error: (error as Error).message });
					}
					return;
				}
				if (req.method === 'PUT') {
					readBody(req).then((body) => {
						try {
							const { content } = JSON.parse(body || '{}') as { content?: string };
							// content 不是字符串（含空 body）时必须拒绝：直接写盘会把已存草稿覆盖成没有正文的残骸
							if (typeof content !== 'string') {
								sendJson(res, 400, { error: '请求体缺少字符串字段 content，已取消保存' });
								return;
							}
							sendJson(res, 200, { task: uploadTasks.write(name, content) });
						} catch (error) {
							sendJson(res, 400, { error: (error as Error).message });
						}
					});
					return;
				}
				if (req.method === 'DELETE') {
					try {
						sendJson(res, 200, { ok: uploadTasks.remove(name) });
					} catch (error) {
						sendJson(res, 400, { error: (error as Error).message });
					}
					return;
				}
			}

			const scanDiff = /^\/api\/scans\/([^/]+)\/diff$/.exec(url.pathname);
			if (scanDiff && req.method === 'GET') {
				const scan = scans.page(decodeURIComponent(scanDiff[1]), 0, 0);
				if (!scan) {
					sendJson(res, 404, { error: '扫描结果不存在' });
					return;
				}
				const page = url.searchParams.get('page') ?? '';
				// 不先查"这页在不在扫描结果里"：diffByRules 本身就是权威判定——
				// 按最新内容与规则算下来没改动就返回 unchanged，多查一次命中表是多余的
				const wiki = scan.meta.wiki as 'zh' | 'cm';
				pageText
					.diffByRules(wiki, page, scan.meta.rules)
					.then((outcome) => {
						if (!outcome.ok) {
							sendJson(res, outcome.reason === 'error' ? 500 : 409, { error: outcome.message, reason: outcome.reason });
							return;
						}
						sendJson(res, 200, { page, lines: outcome.lines, stats: outcome.stats });
					})
					.catch((error: Error) => sendJson(res, 500, { error: error.message }));
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

			const historyDiff = /^\/api\/history\/(.+)\/diff$/.exec(url.pathname);
			if (historyDiff && req.method === 'GET') {
				const taskId = decodeURIComponent(historyDiff[1]);
				const page = url.searchParams.get('page') ?? '';
				const detail = history.getTask(taskId);
				if (!detail) {
					sendJson(res, 404, { error: '任务不存在' });
					return;
				}
				const row = detail.pages.find((item) => item.title === page);
				if (!row) {
					sendJson(res, 404, { error: `任务里没有页面 "${page}"` });
					return;
				}
				// 历史库只存参数 JSON，站点取自 --wiki；参数串坏掉或取值异常一律退回 zh，不阻断 diff
				let params: Record<string, unknown> = {};
				try {
					params = JSON.parse(detail.task.paramsJson || '{}') as Record<string, unknown>;
				} catch {
					params = {};
				}
				const wiki = params['--wiki'] === 'cm' ? 'cm' : 'zh';
				pageText
					.diffByRevid(wiki, page, row.oldRevid ?? 0, row.newRevid ?? 0)
					.then((outcome) => {
						if (!outcome.ok) {
							sendJson(res, outcome.reason === 'error' ? 500 : 409, { error: outcome.message, reason: outcome.reason });
							return;
						}
						sendJson(res, 200, { page, oldRevid: outcome.oldRevid, newRevid: outcome.newRevid, lines: outcome.lines, stats: outcome.stats });
					})
					.catch((error: Error) => sendJson(res, 500, { error: error.message }));
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
					readBody(req)
						.then((body) => {
							try {
								const { page, force } = JSON.parse(body || '{}') as { page?: string; force?: boolean };
								publisher
									.publish(name, { page, force: force === true })
									.then((result) => sendJson(res, result.ok ? 200 : 409, result))
									.catch((error: Error) => sendJson(res, 500, { error: error.message }));
							} catch (error) {
								sendJson(res, 400, { error: (error as Error).message });
							}
						})
						.catch((error: Error) => sendJson(res, 400, { error: error.message }));
					return;
				}
				if (req.method === 'GET') {
					const draft = rulesets.read(name);
					// 线上内容按目标页取：显式传的页 > 草稿记的页 > 默认前缀拼名
					const page = (url.searchParams.get('page') ?? '').trim() || draft?.page || pageTitleFor(name);
					publisher
						.fetchRemote(page)
						.then((remote) => sendJson(res, 200, { draft, remote }))
						.catch((error: Error) => sendJson(res, 500, { error: error.message }));
					return;
				}
				if (req.method === 'PUT') {
					readBody(req).then((body) => {
						try {
							const { content, page } = JSON.parse(body || '{}') as { content?: string; page?: string };
							// content 不是字符串（含空 body、上传中断被 readBody 兜底成 ''）时必须拒绝：
							// 直接写盘会把已存草稿覆盖成没有正文的残骸，而 200 会让调用方毫无察觉
							if (typeof content !== 'string') {
								sendJson(res, 400, { error: '请求体缺少字符串字段 content，已取消保存' });
								return;
							}
							const existing = rulesets.read(name);
							const target = typeof page === 'string' && page.trim() !== '' ? page.trim() : undefined;
							sendJson(res, 200, { draft: rulesets.write(name, content, draftBaseline(existing, target), target) });
						} catch (error) {
							sendJson(res, 400, { error: (error as Error).message });
						}
					});
					return;
				}
			}

			if (url.pathname === '/api/restore-queue' && req.method === 'GET') {
				// 队列页在 zh；读正文要登录，失败降级成 500 而不是打挂服务
				getSession('zh')
					.then((api) => readPage(api, QUEUE_PAGE).then((remote) => {
						if (remote.content === null) {
							sendJson(res, 409, { error: '队列页不存在或无法读取' });
							return;
						}
						let entries: string[];
						try {
							entries = parseQueue(remote.content);
						} catch (error) {
							sendJson(res, 400, { error: (error as Error).message });
							return;
						}
						sendJson(res, 200, { page: QUEUE_PAGE, revid: remote.revid, content: remote.content, entries });
					}))
					.catch((error: Error) => sendJson(res, 500, { error: error.message }));
				return;
			}

			if (url.pathname === '/api/restore-queue' && req.method === 'PUT') {
				readBody(req).then((bodyText) => {
					let request: ReturnType<typeof parseQueueSaveRequest>;
					try {
						request = parseQueueSaveRequest(JSON.parse(bodyText || '{}'));
					} catch (error) {
						sendJson(res, 400, { error: (error as Error).message });
						return;
					}
					getSession('zh')
						.then((api) => writePage(api, {
							title: QUEUE_PAGE,
							text: renderQueue(request.entries),
							baseRevid: request.baseRevid,
							force: request.force,
							summary: '机器人：更新还原队列',
						}))
						.then((result) => sendJson(res, result.ok ? 200 : 409, result))
						.catch((error: Error) => sendJson(res, 500, { error: error.message }));
				});
				return;
			}

			if (url.pathname === '/api/link-config' && req.method === 'GET') {
				const page = (url.searchParams.get('page') ?? '').trim();
				if (page === '') {
					sendJson(res, 400, { error: '缺少 page 查询参数' });
					return;
				}
				getSession('zh')
					.then((api) => readPage(api, page).then((remote) => {
						if (remote.content === null) {
							sendJson(res, 409, { error: `配置页不存在或无法读取：${page}` });
							return;
						}
						sendJson(res, 200, { page, revid: remote.revid, content: remote.content });
					}))
					.catch((error: Error) => sendJson(res, 500, { error: error.message }));
				return;
			}

			if (url.pathname === '/api/link-config' && req.method === 'PUT') {
				readBody(req).then((bodyText) => {
					let request: ReturnType<typeof parsePageSaveRequest>;
					try {
						request = parsePageSaveRequest(JSON.parse(bodyText || '{}'));
					} catch (error) {
						sendJson(res, 400, { error: (error as Error).message });
						return;
					}
					getSession('zh')
						.then((api) => writePage(api, {
							title: request.page,
							text: request.content,
							baseRevid: request.baseRevid,
							force: request.force,
							summary: '机器人：更新链接替换配置',
						}))
						.then((result) => sendJson(res, result.ok ? 200 : 409, result))
						.catch((error: Error) => sendJson(res, 500, { error: error.message }));
				});
				return;
			}

			// 未匹配到任何接口的 /api/* 一律回 JSON 404：否则会落到 serveStatic 的 SPA 回退，
			// 以 200 返回 index.html，调用方见 200 当成功、拿到 undefined 才在别处炸开，极难定位
			if (url.pathname.startsWith('/api/')) {
				sendJson(res, 404, { error: '未知接口' });
				return;
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

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
};

// 预览接口按真实类型返回的白名单：只有浏览器不会在其中执行脚本的位图格式。
// .svg（image/svg+xml）能带脚本，刻意不列入，代价是 SVG 缩略图拿不到真实类型、会显示占位。
const PREVIEW_IMAGE_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
};

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
		const type = MIME_TYPES[extname(name)] ?? 'application/octet-stream';
		res.writeHead(200, { 'content-type': type });
		res.end(body);
	} catch {
		// 单页应用用 hash 路由，但深链接仍可能落到服务端；不含扩展名的路径一律回首页
		if (extname(name) === '') {
			try {
				const fallback = readFileSync(resolve(PUBLIC_DIR, 'index.html'));
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end(fallback);
				return;
			} catch {
				// 连首页都没有：走下面的 404
			}
		}
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('未找到');
	}
}
