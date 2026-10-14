import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChildArgs } from './taskRunner.js';

test('子进程参数用当前 node 加 tsx 加载器，避免依赖 npx 与 shell 引号', () => {
	const args = buildChildArgs('src/replace/TextReplace.ts', ['--wiki', 'zh', '--dry-run']);
	assert.equal(args[0], '--import');
	assert.equal(args[1], 'tsx');
	assert.equal(args[2], 'src/replace/TextReplace.ts');
	assert.deepEqual(args.slice(3), ['--wiki', 'zh', '--dry-run']);
});
