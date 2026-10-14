import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createZhApi } from '../utils/createApi.js';
import clientlogin from '../clientlogin.js';
import config from '../config.js';

const PAGE_PREFIX = 'User:没有羽翼的格雷塔/BotConfig/';

export interface RulesetDraft {
	name: string;
	baseRevid: number | null;
	content: string;
	updatedAt: number;
}

export interface RulesetSummary {
	name: string;
	pageTitle: string;
	draftUpdatedAt: number | null;
}

/** 规则集名必须能安全地当文件名，且不能逃出草稿目录 */
export function safeName(name: string): string {
	if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
		throw new Error(`规则集名 "${name}" 非法：不能为空，且不能包含斜杠或 ..`);
	}
	return name;
}

export function pageTitleFor(name: string): string {
	return `${PAGE_PREFIX}${safeName(name)}`;
}

export class RulesetStore {
	private readonly dir: string;

	constructor(draftDir: string) {
		this.dir = resolve(draftDir);
		mkdirSync(this.dir, { recursive: true });
	}

	private fileFor(name: string): string {
		return resolve(this.dir, `${safeName(name)}.json`);
	}

	list(): RulesetSummary[] {
		return readdirSync(this.dir)
			.filter((file) => file.endsWith('.json'))
			.map((file) => {
				const name = file.slice(0, -'.json'.length);
				const draft = this.read(name);
				return { name, pageTitle: pageTitleFor(name), draftUpdatedAt: draft?.updatedAt ?? null };
			})
			.filter((item) => item.draftUpdatedAt !== null)
			.sort((a, b) => (b.draftUpdatedAt ?? 0) - (a.draftUpdatedAt ?? 0));
	}

	read(name: string): RulesetDraft | null {
		const file = this.fileFor(name);
		if (!existsSync(file)) return null;
		try {
			return JSON.parse(readFileSync(file, 'utf-8')) as RulesetDraft;
		} catch {
			return null;
		}
	}

	write(name: string, content: string, baseRevid: number | null): RulesetDraft {
		const safe = safeName(name);
		const draft: RulesetDraft = { name: safe, baseRevid, content, updatedAt: Date.now() };
		writeFileSync(this.fileFor(safe), JSON.stringify(draft, null, 2), 'utf-8');
		return draft;
	}

	remove(name: string): boolean {
		const file = this.fileFor(name);
		if (!existsSync(file)) return false;
		rmSync(file);
		return true;
	}
}

/** 发布：把草稿写回 wiki 配置页，带 baserevid 冲突检测 */
export class RulesetPublisher {
	private readonly store: RulesetStore;

	constructor(store: RulesetStore) {
		this.store = store;
	}

	private async login() {
		const api = createZhApi();
		await clientlogin(api, config.zh.bot.clientUsername!, config.zh.bot.clientPassword!, config.zh.api);
		return api;
	}

	async fetchRemote(name: string): Promise<{ content: string | null; revid: number | null }> {
		const api = await this.login();
		const { data } = await api.post<any>({
			action: 'query',
			format: 'json',
			formatversion: '2',
			prop: 'revisions',
			rvprop: ['content', 'ids'],
			rvslots: 'main',
			titles: pageTitleFor(name),
		});
		const page = data?.query?.pages?.[0];
		if (!page || page.missing) return { content: null, revid: null };
		const revision = page.revisions?.[0];
		const content = revision?.slots?.main?.content;
		return {
			content: typeof content === 'string' ? content : null,
			revid: typeof revision?.revid === 'number' ? revision.revid : null,
		};
	}

	async publish(name: string): Promise<
		{ ok: true; revid: number | null } | { ok: false; reason: 'conflict' | 'missing'; remote: string | null; remoteRevid: number | null }
	> {
		const draft = this.store.read(name);
		if (!draft) throw new Error(`规则集 "${name}" 没有本地草稿`);
		const remote = await this.fetchRemote(name);
		// 首次发布（线上还不存在）时 baseRevid 必须是 null；此后每次发布都要求 revid 与草稿记录的一致
		if (remote.revid !== draft.baseRevid) {
			return { ok: false, reason: remote.revid === null ? 'missing' : 'conflict', remote: remote.content, remoteRevid: remote.revid };
		}
		const api = await this.login();
		const { data } = await api.postWithEditToken<any>({
			action: 'edit',
			format: 'json',
			formatversion: '2',
			title: pageTitleFor(name),
			text: draft.content,
			summary: `机器人：更新规则集 ${name}`,
			watchlist: 'nochange',
			...(remote.revid === null ? { createonly: 1 } : { baserevid: remote.revid }),
		});
		const newRevid = typeof data?.edit?.newrevid === 'number' ? data.edit.newrevid : null;
		this.store.write(name, draft.content, newRevid);
		return { ok: true, revid: newRevid };
	}
}
