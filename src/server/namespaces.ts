/**
 * 站点命名空间清单与本地镜像覆盖范围。
 *
 * 界面的命名空间复选框靠它列出站点全部命名空间，并标出哪些还没进镜像。
 * 命名空间名来自 siteinfo（站点本地化，权威），覆盖范围只读镜像库 meta 表，
 * 只读连接不与正在跑的任务抢写锁。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MwApiParams } from 'wiki-saikou';
import { createCmApi, createZhApi } from '../utils/createApi.js';
import { DEFAULT_MIRROR_NAMESPACES } from '../utils/siteMirror.js';

export interface NamespaceInfo {
	id: number;
	/** 界面显示名（站点本地化名；主命名空间用「主命名空间」） */
	label: string;
	/** MediaWiki 的英文规范名 */
	canonical: string;
	/** 是否主题命名空间（id 为偶数） */
	subject: boolean;
	/** 是否已在本地镜像覆盖范围内 */
	mirrored: boolean;
}

export interface NamespaceList {
	wiki: 'zh' | 'cm';
	/** 镜像当前覆盖的命名空间编号 */
	mirrorNamespaces: number[];
	namespaces: NamespaceInfo[];
}

/** 查询注入用的 api 抽象：只声明用到的一个方法，真实 MediaWikiApi 结构性兼容它 */
export interface SiteinfoApi {
	post<T>(params: MwApiParams): Promise<{ data: T }>;
}

export type SiteinfoApiFactory = (wiki: 'zh' | 'cm') => Promise<SiteinfoApi>;

/** 默认工厂：meta=siteinfo 是公开查询，无需登录；createZhApi/createCmApi 已注入 User-Agent */
async function defaultSiteinfoApi(wiki: 'zh' | 'cm'): Promise<SiteinfoApi> {
	return wiki === 'zh' ? createZhApi() : createCmApi();
}

/** siteinfo 返回的命名空间条目：formatversion=2 用 name，老写法用 * */
interface SiteinfoNamespace {
	id: number;
	canonical?: string;
	name?: string;
	'*'?: string;
}

/** 取本地名；主命名空间两者皆空，给个中文名免得界面出现空行 */
function pickLabel(info: SiteinfoNamespace): string {
	const local = info.name ?? info['*'] ?? '';
	if (local !== '') return local;
	if (info.canonical) return info.canonical;
	return info.id === 0 ? '主命名空间' : `命名空间 ${info.id}`;
}

export class NamespaceService {
	private readonly createApi: SiteinfoApiFactory;
	private readonly mirrorDir: string;
	/** siteinfo 变化极慢，进程内缓存住即可，省得每次展开复选框都登录一次 */
	private readonly cache = new Map<string, NamespaceInfo[]>();

	constructor(createApi: SiteinfoApiFactory = defaultSiteinfoApi, mirrorDir: string = resolve('data/mirror')) {
		this.createApi = createApi;
		this.mirrorDir = mirrorDir;
	}

	async list(wiki: 'zh' | 'cm'): Promise<NamespaceList> {
		let namespaces = this.cache.get(wiki);
		if (!namespaces) {
			const api = await this.createApi(wiki);
			const { data } = await api.post<{ query?: { namespaces?: Record<string, SiteinfoNamespace> } }>({
				action: 'query',
				format: 'json',
				formatversion: '2',
				meta: 'siteinfo',
				siprop: 'namespaces',
			});
			const raw = data?.query?.namespaces ?? {};
			namespaces = Object.values(raw)
				.map((info) => ({
					id: info.id,
					label: pickLabel(info),
					canonical: info.canonical ?? '',
					subject: info.id % 2 === 0,
					mirrored: false,
				}))
				.sort((a, b) => a.id - b.id);
			this.cache.set(wiki, namespaces);
		}
		const mirrorNamespaces = this.readMirrorNamespaces(wiki);
		return {
			wiki,
			mirrorNamespaces,
			namespaces: namespaces.map((item) => ({ ...item, mirrored: mirrorNamespaces.includes(item.id) })),
		};
	}

	/** 读镜像覆盖范围：meta 表没有记录时用默认值，镜像库不存在或读不出也退回默认值 */
	private readMirrorNamespaces(wiki: 'zh' | 'cm'): number[] {
		const fallback = DEFAULT_MIRROR_NAMESPACES[wiki];
		const dbPath = resolve(this.mirrorDir, `${wiki}.db`);
		if (!existsSync(dbPath)) return fallback;
		let db: DatabaseSync | null = null;
		try {
			// 只读连接不占写锁，与正在跑的同步/替换任务并存
			db = new DatabaseSync(dbPath, { readOnly: true });
			const row = db.prepare("SELECT value FROM meta WHERE key = 'namespaces'").get() as { value: string } | undefined;
			if (!row) return fallback;
			const parsed = JSON.parse(row.value) as unknown;
			if (!Array.isArray(parsed)) return fallback;
			const namespaces = parsed.filter((value): value is number => Number.isInteger(value));
			return namespaces.length > 0 ? namespaces : fallback;
		} catch {
			// 库被占用、版本不符、表结构异常：一律退回默认值，不影响界面展开
			return fallback;
		} finally {
			db?.close();
		}
	}
}
