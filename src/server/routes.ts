import { extname } from 'node:path';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DESCRIPTORS } from '../core/registry.js';
import type { ServerConfig } from './auth.js';

const PUBLIC_DIR = new URL('./public/', import.meta.url);

export function createRouter(_config: ServerConfig) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
		if (url.pathname === '/api/descriptors') {
			sendJson(res, 200, { descriptors: DESCRIPTORS });
			return;
		}
		serveStatic(url.pathname, res);
	};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function serveStatic(pathname: string, res: ServerResponse): void {
	const name = pathname === '/' ? 'index.html' : pathname.slice(1);
	try {
		const body = readFileSync(new URL(name, PUBLIC_DIR));
		const type = extname(name) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
		res.writeHead(200, { 'content-type': type });
		res.end(body);
	} catch {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('未找到');
	}
}
