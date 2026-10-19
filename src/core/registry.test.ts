import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESCRIPTORS, findDescriptor } from './registry.js';
import { buildArgv } from './descriptor.js';
import type { ParamSpec } from './descriptor.js';

test('注册了五个描述符且 id 唯一', () => {
	const ids = DESCRIPTORS.map((d) => d.id);
	assert.deepEqual(ids, ['text-replace', 'auto-patrol', 'url-upload', 'file-restore', 'link-replace']);
	assert.equal(new Set(ids).size, ids.length);
});

test('按 id 查找描述符', () => {
	assert.equal(findDescriptor('auto-patrol')?.entry, 'src/patrol/AutoPatrol.ts');
	assert.equal(findDescriptor('不存在'), undefined);
});

test('TextReplace 用空格风格拼参数', () => {
	const descriptor = findDescriptor('text-replace')!;
	const argv = buildArgv(descriptor, { '--wiki': 'zh', '--namespace': ['0'], '--dry-run': true, '--interval': 1500 });
	assert.deepEqual(argv, ['--wiki', 'zh', '--namespace', '0', '--interval', '1500', '--dry-run']);
});

test('AutoPatrol 用等号风格拼参数，且保留 limit=0', () => {
	const descriptor = findDescriptor('auto-patrol')!;
	const argv = buildArgv(descriptor, { '--mode': 'edit', '--wiki': 'zh', '--days': 7, '--limit': 0, '--dry-run': true });
	assert.deepEqual(argv, ['--mode=edit', '--wiki=zh', '--days=7', '--limit=0', '--dry-run']);
});

test('五个描述符都声明了进度开关，且各自声明了配置文件来源', () => {
	for (const descriptor of DESCRIPTORS) {
		assert.equal(descriptor.progressFlag, '--progress-json');
	}
	assert.equal(findDescriptor('text-replace')?.configFileFlag, '--config-file');
	assert.equal(findDescriptor('text-replace')?.configSource, 'rulesets');
	assert.equal(findDescriptor('url-upload')?.configSource, 'upload-tasks');
	assert.equal(findDescriptor('link-replace')?.configSource, 'link-configs');
	assert.equal(findDescriptor('auto-patrol')?.configFileFlag, undefined);
});

test('有专属页的任务标出路由名', () => {
	assert.equal(findDescriptor('text-replace')?.page, 'text-replace');
	assert.equal(findDescriptor('url-upload')?.page, 'url-upload');
	assert.equal(findDescriptor('file-restore')?.page, 'file-restore');
	assert.equal(findDescriptor('link-replace')?.page, 'link-replace');
	assert.equal(findDescriptor('auto-patrol')?.page, undefined);
});

test('危险开关被标记出来', () => {
	const descriptor = findDescriptor('text-replace')!;
	const danger = descriptor.params
		.filter((p): p is ParamSpec => p.kind !== 'positional' && 'danger' in p && p.danger === true)
		.map((p) => p.flag);
	assert.deepEqual(danger, ['--resync', '--purge-deleted']);
});
