import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteMirror } from '../utils/siteMirror.js';
import { NamespaceService, type SiteinfoApiFactory } from './namespaces.js';

const siteinfo = {
	query: {
		namespaces: {
			'0': { id: 0, case: 'first-letter', canonical: '', name: '' },
			'1': { id: 1, case: 'first-letter', canonical: 'Talk', name: '讨论' },
			'6': { id: 6, case: 'first-letter', canonical: 'File', name: '文件' },
			'10': { id: 10, case: 'first-letter', canonical: 'Template', name: '模板' },
		},
	},
};

// 接口的 post 是泛型方法，桩实现无法逐字满足它，按仓库既有做法整体断言一次
const fakeApi = async () => ({
	post: async () => ({ data: siteinfo }),
}) as unknown as SiteinfoApiFactory;

test('站点命名空间映射成界面条目，主命名空间有中文名', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-ns-'));
	try {
		const service = new NamespaceService(fakeApi, dir);
		const list = await service.list('zh');
		assert.equal(list.wiki, 'zh');
		assert.equal(list.namespaces.find((item) => item.id === 0)?.label, '主命名空间');
		assert.equal(list.namespaces.find((item) => item.id === 1)?.label, '讨论');
		assert.equal(list.namespaces.find((item) => item.id === 1)?.subject, false);
		assert.equal(list.namespaces.find((item) => item.id === 6)?.subject, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('镜像覆盖范围从 meta 表读取，未同步的命名空间被标出来', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-ns-'));
	try {
		const mirror = new SiteMirror(join(dir, 'zh.db'));
		mirror.setNamespaces([0]);
		mirror.close();

		const service = new NamespaceService(fakeApi, dir);
		const list = await service.list('zh');
		assert.deepEqual(list.mirrorNamespaces, [0]);
		assert.equal(list.namespaces.find((item) => item.id === 0)?.mirrored, true);
		assert.equal(list.namespaces.find((item) => item.id === 6)?.mirrored, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('镜像库还不存在时用默认覆盖范围', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-ns-'));
	try {
		const service = new NamespaceService(fakeApi, dir);
		assert.deepEqual((await service.list('cm')).mirrorNamespaces, [6]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('siteinfo 用 * 表示本地名时也能取到', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'gui-ns-'));
	try {
		const legacy = async () => ({
			post: async () => ({ data: { query: { namespaces: { '2': { id: 2, case: 'first-letter', canonical: 'User', '*': '用户' } } } } }),
		}) as unknown as SiteinfoApiFactory;
		const service = new NamespaceService(legacy, dir);
		assert.equal((await service.list('zh')).namespaces[0].label, '用户');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
