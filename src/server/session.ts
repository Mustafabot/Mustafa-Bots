/**
 * 共享登录会话：按站点缓存已登录的 api 实例，首次取用时登录一次，之后复用。
 *
 * 萌百读取正文（prop=revisions）要求登录。若每次取正文都新建 api + 登录，
 * 在界面上翻若干页 diff 就会反复登录。这里按站点挂好登录态、之后 api 操作均复用。
 *
 * 登录失败抛错（exitOnFailure=false），由路由层降级成 500，绝不让进程退出。
 * 会话失效不在本次范围：缓存实例过期后调用失败、报 500 是可接受的现状。
 */
import { MediaWikiApi } from 'wiki-saikou';
import clientlogin from '../clientlogin.js';
import config from '../config.js';
import { createCmApi, createZhApi } from '../utils/createApi.js';

export type WikiName = 'zh' | 'cm';

const cache = new Map<WikiName, Promise<MediaWikiApi>>();

/**
 * 取某站点的已登录 api 实例。首次调用会创建实例并登录，成功后缓存；
 * 之后直接返回同一个实例。登录失败时清掉缓存条目，让下次调用能重试登录，
 * 而不是一直复用同一个被拒的 Promise。
 */
export function getSession(wiki: WikiName): Promise<MediaWikiApi> {
	const cached = cache.get(wiki);
	if (cached) return cached;
	const pending = login(wiki).catch((error: unknown) => {
		cache.delete(wiki);
		throw error;
	});
	cache.set(wiki, pending);
	return pending;
}

async function login(wiki: WikiName): Promise<MediaWikiApi> {
	const api = wiki === 'zh' ? createZhApi() : createCmApi();
	await clientlogin(api, config[wiki].bot.clientUsername!, config[wiki].bot.clientPassword!, config[wiki].api, false);
	return api;
}
