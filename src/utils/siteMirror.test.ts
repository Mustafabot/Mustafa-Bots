import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaWikiApi } from 'wiki-saikou';
import { DEFAULT_MIRROR_NAMESPACES, SiteMirror, syncMirror, type MirrorProgress } from './siteMirror.js';

/** 造一个只回应 syncMirror 所需查询的 api 桩 */
function makeSyncApi(handler: (params: Record<string, unknown>) => unknown): MediaWikiApi {
	return { post: async (params: Record<string, unknown>) => ({ data: handler(params) }) } as unknown as MediaWikiApi;
}

test('从未设置过覆盖范围时返回 null，由调用方决定默认值', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const mirror = new SiteMirror(join(dir, 'zh.db'));
	try {
		assert.equal(mirror.getNamespaces(), null);
		assert.deepEqual(DEFAULT_MIRROR_NAMESPACES, { zh: [0], cm: [6] });
	} finally {
		mirror.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('覆盖范围写进 meta 表，重新打开仍在', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const first = new SiteMirror(join(dir, 'zh.db'));
	try {
		first.setNamespaces([0, 6, 10]);
		assert.deepEqual(first.getNamespaces(), [0, 6, 10]);
	} finally {
		first.close();
	}
	const second = new SiteMirror(join(dir, 'zh.db'));
	try {
		assert.deepEqual(second.getNamespaces(), [0, 6, 10]);
	} finally {
		second.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('值损坏时返回 null 而不是抛错', () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const mirror = new SiteMirror(join(dir, 'zh.db'));
	try {
		mirror.setMeta('namespaces', '坏掉的 json');
		assert.equal(mirror.getNamespaces(), null);
	} finally {
		mirror.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('全量同步过程中报告已抓取的页数', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const mirror = new SiteMirror(join(dir, 'zh.db'));
	const progress: MirrorProgress[] = [];
	try {
		const api = makeSyncApi(() => ({
			query: {
				pages: [
					{ title: '甲', pageid: 1, ns: 0, revisions: [{ revid: 11, slots: { main: { content: '正文甲' } } }] },
					{ title: '乙', pageid: 2, ns: 0, revisions: [{ revid: 12, slots: { main: { content: '正文乙' } } }] },
				],
			},
		}));
		const result = await syncMirror({ api, mirror, namespaces: [0], requestInterval: 0, log: () => {}, onProgress: (item) => progress.push(item) });
		assert.equal(result.mode, 'full');
		assert.equal(result.upserted, 2);
		// 全量抓取预先不知道总数，只能报已抓页数（total 留空，界面据此显示不定长进度）
		assert.ok(
			progress.some((item) => item.done === 2 && item.total === undefined),
			JSON.stringify(progress),
		);
	} finally {
		mirror.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('增量补拉时报告已补拉/待补拉页数', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-mirror-'));
	const mirror = new SiteMirror(join(dir, 'zh.db'));
	const progress: MirrorProgress[] = [];
	try {
		mirror.upsertPages([
			{ title: '甲', pageid: 1, ns: 0, revid: 1, text: '甲' },
			{ title: '乙', pageid: 2, ns: 0, revid: 2, text: '乙' },
		]);
		mirror.setMeta('sync_progress', JSON.stringify({ '0': true }));
		const api = makeSyncApi((params) => {
			// 按标题补拉正文
			if (params.titles !== undefined) {
				return { query: { pages: [{ title: '乙', pageid: 2, ns: 0, revisions: [{ revid: 99, slots: { main: { content: '乙新' } } }] }] } };
			}
			// 全量 revid 清单：乙的 revid 变了
			return {
				query: {
					pages: [
						{ title: '甲', pageid: 1, ns: 0, revisions: [{ revid: 1 }] },
						{ title: '乙', pageid: 2, ns: 0, revisions: [{ revid: 99 }] },
					],
				},
			};
		});
		const result = await syncMirror({ api, mirror, namespaces: [0], requestInterval: 0, log: () => {}, onProgress: (item) => progress.push(item) });
		assert.equal(result.mode, 'incremental');
		assert.equal(result.upserted, 1);
		// 比对后已知待补拉总数，进度条应能显示 1/1
		assert.ok(
			progress.some((item) => item.done === 1 && item.total === 1),
			JSON.stringify(progress),
		);
	} finally {
		mirror.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
