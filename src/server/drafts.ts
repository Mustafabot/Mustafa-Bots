/**
 * 本地草稿库：按目录把一份正文存成一个 JSON 文件，供界面复用。
 *
 * 规则集与上传任务各用一个目录，存的东西不同但取放方式一样，
 * 故把"目录创建、名字净化、文件读写删"放在这里，各自的记录形状由子类拼。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 草稿名必须能安全地当文件名，且不能逃出草稿目录 */
export function safeDraftName(name: string): string {
	// ':' 必须挡掉：Windows 上 `C:evil` 是驱动器相对路径，
	// resolve 后会落到进程工作目录而不是草稿目录
	if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes(':')) {
		throw new Error(`草稿名 "${name}" 非法：不能为空，且不能包含斜杠、冒号或 ..`);
	}
	return name;
}

/** 名字加正文加更新时间：最常见的草稿形状 */
export interface DraftRecord {
	name: string;
	content: string;
	updatedAt: number;
}

export class DraftStore {
	protected readonly dir: string;

	constructor(dir: string) {
		this.dir = resolve(dir);
		mkdirSync(this.dir, { recursive: true });
	}

	protected fileFor(name: string): string {
		return resolve(this.dir, `${safeDraftName(name)}.json`);
	}

	/** 目录下的草稿名（不含扩展名）；损坏或名字非法的文件由调用方跳过 */
	listFiles(): string[] {
		return readdirSync(this.dir)
			.filter((file) => file.endsWith('.json'))
			.map((file) => file.slice(0, -'.json'.length));
	}

	/** 读原始记录；文件不存在或 JSON 坏掉返回 null */
	readRaw(name: string): Record<string, unknown> | null {
		const file = this.fileFor(name);
		if (!existsSync(file)) return null;
		try {
			return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	writeRaw(name: string, record: Record<string, unknown>): void {
		writeFileSync(this.fileFor(name), JSON.stringify(record, null, 2), 'utf-8');
	}

	remove(name: string): boolean {
		const file = this.fileFor(name);
		if (!existsSync(file)) return false;
		rmSync(file);
		return true;
	}
}

/** 只存名字与正文的草稿库：上传任务用它 */
export class TextDraftStore extends DraftStore {
	list(): Array<{ name: string; updatedAt: number }> {
		return this.listFiles()
			.map((name) => {
				try {
					const record = this.read(name);
					return record === null ? null : { name, updatedAt: record.updatedAt };
				} catch {
					// 名字非法：跳过这一条
					return null;
				}
			})
			.filter((item): item is { name: string; updatedAt: number } => item !== null)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	read(name: string): DraftRecord | null {
		const raw = this.readRaw(name);
		if (raw === null) return null;
		const content = raw.content;
		return {
			name,
			content: typeof content === 'string' ? content : '',
			updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
		};
	}

	write(name: string, content: string): DraftRecord {
		const safe = safeDraftName(name);
		const record: DraftRecord = { name: safe, content, updatedAt: Date.now() };
		this.writeRaw(safe, { ...record });
		return record;
	}
}
