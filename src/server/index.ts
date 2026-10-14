import { createServer } from 'node:http';
import { assertSafeBind, readServerConfig } from './auth.js';
import { createRouter } from './routes.js';
import { TaskRunner } from './taskRunner.js';

const config = readServerConfig();
assertSafeBind(config.host, config.password);

// runner 提到入口创建：关停时要能查到“是否还有任务在跑”，路由层默认自行 new 一份即可
const runner = new TaskRunner();
const server = createServer(createRouter(config, runner));

server.listen(config.port, config.host, () => {
	const mode = config.password ? '已启用口令' : '无口令（仅本机）';
	console.log(`GUI 服务已启动: http://${config.host}:${config.port}（${mode}）`);
});

const shutdown = () => {
	// 一期子进程未 detach，其 stdout/stderr 是本进程的管道：服务退出后管道断开，
	// 子进程下一次写输出就会 EPIPE 而死，等于把任务一并带走。这里先把话说明白。
	const running = runner.current;
	if (running && running.status === 'running') {
		console.warn(`警告：任务「${running.label}」仍在运行，关闭服务会将它一并终止（未完成的页面需下次重跑）。`);
	}
	server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
