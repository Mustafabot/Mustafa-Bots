/**
 * 界面上传上来的本机文件暂存区。
 *
 * 放在 data/gui/uploads/ 而不是 temp/：外部图片迁移在启动时会清空 temp/，
 * 会把界面刚收下的文件一起删掉。文件不自动清理，界面上给手动清理入口。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, resolve, sep } from 'node:path';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SIZE_TEXT } from '../upload/uploadConfig.js';

/** 相对仓库根的暂存目录：上传脚本以仓库根为工作目录，配置里的 file 就写这个相对路径 */
export const UPLOAD_REL_DIR = 'data/gui/uploads';
export const UPLOAD_DIR = resolve(UPLOAD_REL_DIR);

function ensureDir(): void {
	mkdirSync(UPLOAD_DIR, { recursive: true });
}

/** 只取基本名并挡掉逃逸与空名；Windows 与 POSIX 的分隔符都当分隔符 */
export function safeUploadName(name: string): string {
	const base = basename(name.replace(/\\/g, '/'));
	// 控制字符一并拒掉（含 NUL）：名字来自查询参数，POSIX 上 basename 不会剥掉 \r\n 之类，
	// 放进去会污染响应头与文件系统。用码点扫描而不是正则，因为含控制字符的正则会被 lint 禁掉。
	const hasControlChar = [...base].some((ch) => ch.charCodeAt(0) < 0x20);
	if (base === '' || base === '.' || base === '..' || hasControlChar) {
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
	// 与 serveStatic 同一套判据：带上分隔符，免得相邻的 uploads-x/ 被当成目录内
	if (target !== UPLOAD_DIR && !target.startsWith(UPLOAD_DIR + sep)) return null;
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

/** 列出暂存目录里的文件与总大小：界面的清理动作据此告诉用户会删掉多少 */
export function listUploads(): { files: Array<{ name: string; size: number }>; total: number } {
	if (!existsSync(UPLOAD_DIR)) return { files: [], total: 0 };
	const files: Array<{ name: string; size: number }> = [];
	let total = 0;
	for (const name of readdirSync(UPLOAD_DIR).sort()) {
		try {
			// 进程被中断留下的 <名字>.<uuid>.part 也照列：清理动作会把它一并删掉
			const size = statSync(resolve(UPLOAD_DIR, name)).size;
			files.push({ name, size });
			total += size;
		} catch {
			// 单个条目读不到大小就跳过，不影响其余
		}
	}
	return { files, total };
}

/** 接收一个文件：请求体就是原始字节，边收边写，超限即断 */
export function receiveUpload(req: IncomingMessage, res: ServerResponse, name: string): void {
	ensureDir();
	const safe = safeUploadName(name);
	const target = resolve(UPLOAD_DIR, safe);
	// 先写 <名字>.<uuid>.part、收完且长度达标才改名到目标名：任何失败路径只删 .part，
	// 绝不碰已存在的同名正式文件。否则"先传好 a.png、随后误传一个 25 MB 的 a.png"
	// 会在校验前就把好的那个删掉、新文件又没写成，落得两头空。
	// 后缀带 uuid 是为了并发同名上传时各写各的临时文件，不会把两股字节追加进同一个路径，
	// 完成时的 rename 依旧是原子替换到目标名。
	const part = `${target}.${randomUUID()}.part`;
	let received = 0;
	let aborted = false;

	// 客户端中途断开时下面还要写响应，写到一个已销毁的 socket 上会抛 'error'；
	// 不挂监听就会变成未捕获异常把整个服务带下线（同 routes.ts 里 res.on('error') 的缘由）
	res.on('error', () => {});

	const cleanupPart = (): void => {
		if (existsSync(part)) {
			try {
				unlinkSync(part);
			} catch {
				// 清理失败就留下半截临时文件，下次写入会覆盖它
			}
		}
	};

	const fail = (status: number, error: string): void => {
		aborted = true;
		cleanupPart();
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify({ error }));
	};

	req.on('data', (chunk: Buffer) => {
		if (aborted) return;
		received += chunk.length;
		if (received > MAX_UPLOAD_BYTES) {
			fail(413, `文件超过 ${MAX_UPLOAD_SIZE_TEXT} 上限（共享站的上传上限），请先压缩`);
			return;
		}
		// 逐块追加：图片最大 20 MB，直接缓冲也不会吃满内存，但仍按流写以免留两份拷贝。
		// 磁盘满等写入失败必须当场兜住：裸抛出会把整个 GUI 服务带下线
		try {
			writeFileSync(part, chunk, { flag: 'a' });
		} catch (error) {
			fail(500, `写入文件失败：${(error as Error).message}`);
		}
	});
	req.on('end', () => {
		if (aborted) return;
		// 0 字节等于没传东西：回 200 会让界面当成功，随后预览必然 404
		if (received === 0) {
			fail(400, '收到的是空文件，没有内容可存');
			return;
		}
		try {
			// rename 覆盖同名正式文件（POSIX 与 Windows 都是替换语义），与"后传覆盖先传"的约定一致
			renameSync(part, target);
		} catch (error) {
			fail(500, `保存文件失败：${(error as Error).message}`);
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		// path 是相对仓库根的路径（正斜杠）：上传脚本以仓库根为工作目录，草稿里的 file 直接写它。
		// 只给文件名的话，脚本按仓库根解析就找不到文件，校验会以"本机文件不存在"拒绝。
		res.end(JSON.stringify({ name: safe, size: received, path: `${UPLOAD_REL_DIR}/${safe}` }));
	});
	req.on('error', () => {
		if (!aborted) fail(400, '接收文件时连接中断');
	});
}
