import { createServer } from 'node:http';
import { assertSafeBind, readServerConfig } from './auth.js';
import { createRouter } from './routes.js';

const config = readServerConfig();
assertSafeBind(config.host, config.password);

const server = createServer(createRouter(config));

server.listen(config.port, config.host, () => {
	const mode = config.password ? '已启用口令' : '无口令（仅本机）';
	console.log(`GUI 服务已启动: http://${config.host}:${config.port}（${mode}）`);
});

const shutdown = () => {
	server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
