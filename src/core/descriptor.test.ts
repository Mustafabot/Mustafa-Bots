import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgv, validateValues, type TaskDescriptor } from './descriptor.js';

const spaceStyle: TaskDescriptor = {
	id: 'space',
	label: '空格风格',
	entry: 'x.ts',
	style: 'space',
	progressFlag: '--progress-json',
	quietFlag: '--quiet',
	params: [
		{ kind: 'enum', flag: '--wiki', label: '站点', default: 'zh', options: [{ value: 'zh', label: '主站' }] },
		{ kind: 'stringList', flag: '--namespace', label: '命名空间', separator: ',' },
		{ kind: 'boolean', flag: '--dry-run', label: '空跑' },
		{ kind: 'boolean', flag: '--resync', label: '重建', danger: true },
		{ kind: 'number', flag: '--interval', label: '间隔', default: 1500 },
		{ kind: 'positional', name: 'from', label: '原文', index: 0 },
		{ kind: 'positional', name: 'to', label: '新文', index: 1 },
	],
};

const equalsStyle: TaskDescriptor = {
	id: 'equals',
	label: '等号风格',
	entry: 'y.ts',
	style: 'equals',
	progressFlag: '--progress-json',
	quietFlag: '--quiet',
	params: [
		{ kind: 'enum', flag: '--mode', label: '模式', default: 'all', options: [{ value: 'all', label: '全部' }] },
		{ kind: 'number', flag: '--limit', label: '上限', default: 0 },
		{ kind: 'boolean', flag: '--dry-run', label: '空跑' },
	],
};

test('空格风格输出为 flag 与值两个 argv 元素', () => {
	const argv = buildArgv(spaceStyle, { '--wiki': 'zh', '--namespace': ['0', '10'], '--interval': 1500 });
	assert.deepEqual(argv, ['--wiki', 'zh', '--namespace', '0,10', '--interval', '1500']);
});

test('等号风格输出为单个 argv 元素', () => {
	const argv = buildArgv(equalsStyle, { '--mode': 'edit', '--limit': 500, '--dry-run': true });
	assert.deepEqual(argv, ['--mode=edit', '--limit=500', '--dry-run']);
});

test('数值 0 不会被当作空值丢弃', () => {
	const argv = buildArgv(equalsStyle, { '--limit': 0 });
	assert.deepEqual(argv, ['--limit=0']);
});

test('布尔为 false 时不产生参数', () => {
	assert.deepEqual(buildArgv(equalsStyle, { '--dry-run': false }), []);
});

test('空字符串与空数组被跳过', () => {
	assert.deepEqual(buildArgv(spaceStyle, { '--wiki': '', '--namespace': [] }), []);
});

test('位置参数按 index 排在参数之前', () => {
	const argv = buildArgv(spaceStyle, { '--wiki': 'zh', to: '新', from: '旧' });
	assert.deepEqual(argv, ['旧', '新', '--wiki', 'zh']);
});

test('枚举取值非法时给出错误', () => {
	const errors = validateValues(equalsStyle, { '--mode': '乱来' });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /--mode/);
});

test('数值越界时给出错误', () => {
	const descriptor: TaskDescriptor = {
		...equalsStyle,
		params: [{ kind: 'number', flag: '--days', label: '天数', default: 30, min: 1 }],
	};
	assert.match(validateValues(descriptor, { '--days': 0 })[0], /--days/);
	assert.deepEqual(validateValues(descriptor, { '--days': 7 }), []);
});
