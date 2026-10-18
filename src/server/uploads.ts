/**
 * 界面上传上来的本机文件暂存区。
 *
 * 放在 data/gui/uploads/ 而不是 temp/：外部图片迁移在启动时会清空 temp/，
 * 会把界面刚收下的文件一起删掉。文件不自动清理，界面上给手动清理入口。
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, resolve } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../upload/uploadConfig.js';

export const UPLOAD_DIR = resolve('data/gui/uploads');

function ensureDir(): void {
	mkdirSync(UPLOAD_DIR, { recursive: true });
}

/** 只取基本名并挡掉逃逸与空名；Windows 与 POSIX 的分隔符都当分隔符 */
export function safeUploadName(name: string): string {
	const base = basename(name.replace(/\\/g, '/'));
	if (base === '' || base === '.' || base === '..' || base.includes('\0')) {
		throw new Error('文件名不能为空，也不能是 . 或 ..');
	}
	return base;
}

/** 目录内的文件路径；越界或不存在返回 null */
export function resolveUpload(name: string): string | null {
	let safe: string;
	try {
		safe = safeUploadName(decodeURIComponent(name));
	} catch {
		return null;
	}
	const target = resolve(UPLOAD_DIR, safe);
	if (!target.startsWith(UPLOAD_DIR)) return null;
	return existsSync(target) ? target : null;
}

/** 清空上传目录，返回删掉的文件数 */
export function clearUploads(): number {
	if (!existsSync(UPLOAD_DIR)) return 0;
	let removed = 0;
	for (const file of readdirSync(UPLOAD_DIR)) {
		try {
			unlinkSync(resolve(UPLOAD_DIR, file));
			removed++;
		} catch {
			// 单个文件删不掉不影响其余
		}
	}
	return removed;
}

/** 接收一个文件：请求体就是原始字节，边收边写，超限即断 */
export function receiveUpload(req: IncomingMessage, res: ServerResponse, name: string): void {
	ensureDir();
	const target = resolve(UPLOAD_DIR, safeUploadName(name));
	// 同名文件先删掉：下面按块追加写入，留着旧文件会拼出一份坏数据
	if (existsSync(target)) unlinkSync(target);
	let received = 0;
	let aborted = false;

	const fail = (status: number, error: string): void => {
		aborted = true;
		if (existsSync(target)) {
			try {
				unlinkSync(target);
			} catch {
				// 清理失败就留下半截文件，下次写入会覆盖它
			}
		}
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify({ error }));
	};

	req.on('data', (chunk: Buffer) => {
		if (aborted) return;
		received += chunk.length;
		if (received > MAX_UPLOAD_BYTES) {
			fail(413, '文件超过 20 MB 上限（共享站的上传上限），请先压缩');
			return;
		}
		// 逐块追加：图片最大 20 MB，直接缓冲也不会吃满内存，但仍按流写以免留两份拷贝
		writeFileSync(target, chunk, { flag: 'a' });
	});
	req.on('end', () => {
		if (aborted) return;
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify({ name: safeUploadName(name), size: received }));
	});
	req.on('error', () => {
		if (!aborted) fail(400, '接收文件时连接中断');
	});
}
