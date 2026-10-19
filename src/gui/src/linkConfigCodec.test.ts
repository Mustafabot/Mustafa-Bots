import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLinkConfig, emptyLinkConfig, encodeLinkConfig, validateLinkConfigForm, type LinkConfigForm } from './linkConfigCodec';

/** 一份填满的表单，供往返用例 */
function fullForm(): LinkConfigForm {
	return {
		mode: 'move',
		namespaces: [0, 6],
		pages: ['苹果', '梨'],
		noredirect: true,
		movetalk: false,
		linkTemplates: [{ name: 'Template:Infobox', param: '1', displayParam: '2', valueSeparator: ',' }],
		replacements: [{ from: '苹果', to: '苹果(植物)#产地' }, { from: '视频', to: '影片' }],
	};
}

test('编码出脚本认得的配置形状', () => {
	assert.deepEqual(JSON.parse(encodeLinkConfig(fullForm())), {
		mode: 'move',
		namespaces: [0, 6],
		pages: ['苹果', '梨'],
		move: { noredirect: true, movetalk: false },
		linkTemplates: [{ name: 'Template:Infobox', param: 1, displayParam: 2, valueSeparator: ',' }],
		replacements: [{ from: '苹果', to: '苹果(植物)#产地' }, { from: '视频', to: '影片' }],
	});
});

test('replace 模式不输出 move，空数组与空列表省略', () => {
	const form: LinkConfigForm = { ...emptyLinkConfig(), pages: ['苹果'], replacements: [{ from: '苹果', to: '梨' }] };
	assert.deepEqual(JSON.parse(encodeLinkConfig(form)), {
		mode: 'replace',
		pages: ['苹果'],
		replacements: [{ from: '苹果', to: '梨' }],
	});
});

test('参数位支持单值、多值与 all', () => {
	const form: LinkConfigForm = {
		...emptyLinkConfig(),
		pages: ['苹果'],
		replacements: [{ from: '苹果', to: '梨' }],
		linkTemplates: [
			{ name: 'Template:A', param: '1', displayParam: '', valueSeparator: '' },
			{ name: 'Template:B', param: '1,2', displayParam: '', valueSeparator: '' },
			{ name: 'Template:C', param: 'all', displayParam: '', valueSeparator: '' },
		],
	};
	const encoded = JSON.parse(encodeLinkConfig(form)) as { linkTemplates: Array<{ name: string; param: unknown }> };
	assert.deepEqual(encoded.linkTemplates.map((t) => t.param), [1, [1, 2], 'all']);
});

test('缺名字或缺参数的模板行整行跳过', () => {
	const form: LinkConfigForm = {
		...emptyLinkConfig(),
		pages: ['苹果'],
		replacements: [{ from: '苹果', to: '梨' }],
		linkTemplates: [
			{ name: '', param: '1', displayParam: '', valueSeparator: '' },
			{ name: 'Template:B', param: 'abc', displayParam: '', valueSeparator: '' },
		],
	};
	const encoded = JSON.parse(encodeLinkConfig(form)) as { linkTemplates?: unknown };
	assert.equal(encoded.linkTemplates, undefined);
});

test('参数位含空段的写法被拒绝，不再悄悄当成 0', () => {
	const form: LinkConfigForm = {
		...emptyLinkConfig(),
		pages: ['苹果'],
		replacements: [{ from: '苹果', to: '梨' }],
		linkTemplates: [{ name: 'Template:A', param: '1,', displayParam: '', valueSeparator: '' }],
	};
	const encoded = JSON.parse(encodeLinkConfig(form)) as { linkTemplates?: unknown };
	assert.equal(encoded.linkTemplates, undefined);
});

test('解码把参数位还原成字符串形式', () => {
	const form = decodeLinkConfig(JSON.stringify({
		mode: 'move',
		namespaces: [0],
		pages: ['苹果'],
		move: { noredirect: true, movetalk: false },
		linkTemplates: [{ name: 'Template:A', param: [1, 2], displayParam: 3, valueSeparator: ',' }],
		replacements: [{ from: '苹果', to: '梨' }],
	}));
	assert.equal(form.mode, 'move');
	assert.deepEqual(form.namespaces, [0]);
	assert.deepEqual(form.pages, ['苹果']);
	assert.equal(form.noredirect, true);
	assert.equal(form.movetalk, false);
	assert.deepEqual(form.linkTemplates, [{ name: 'Template:A', param: '1,2', displayParam: '3', valueSeparator: ',' }]);
});

test('坏 JSON 与错类型退回默认值，不抛错', () => {
	const empty = emptyLinkConfig();
	assert.deepEqual(decodeLinkConfig('{坏'), empty);
	assert.deepEqual(decodeLinkConfig('[]'), empty);
	assert.deepEqual(decodeLinkConfig('{"mode":"乱写","pages":"不是数组","replacements":[{"from":1}]}'), empty);
});

test('未给 mode 时按 replace 处理', () => {
	assert.equal(decodeLinkConfig(JSON.stringify({ pages: ['苹果'], replacements: [{ from: '苹果', to: '梨' }] })).mode, 'replace');
});

test('编解码往返保留填过的内容', () => {
	const form = fullForm();
	const back = decodeLinkConfig(encodeLinkConfig(form));
	assert.equal(back.mode, 'move');
	assert.deepEqual(back.namespaces, [0, 6]);
	assert.deepEqual(back.pages, ['苹果', '梨']);
	assert.equal(back.noredirect, true);
	assert.equal(back.movetalk, false);
	assert.deepEqual(back.replacements, form.replacements);
	assert.deepEqual(back.linkTemplates, form.linkTemplates);
});

test('表单校验：完整的表单没有错误', () => {
	assert.deepEqual(validateLinkConfigForm(fullForm()), []);
});

test('表单校验：缺规则、缺页面来源、from 与 to 相同、纯锚点、模板缺参数都会被拦下', () => {
	assert.match(validateLinkConfigForm({ ...fullForm(), replacements: [] }).join('；'), /至少需要一条替换规则/);
	assert.match(validateLinkConfigForm({ ...fullForm(), pages: [], namespaces: [] }).join('；'), /至少要有显式页面/);
	assert.match(validateLinkConfigForm({ ...fullForm(), replacements: [{ from: '苹果', to: '苹果' }] }).join('；'), /「从」与「到」相同/);
	assert.match(validateLinkConfigForm({ ...fullForm(), replacements: [{ from: '#锚点', to: '苹果' }] }).join('；'), /标题部分不能为空/);
	assert.match(validateLinkConfigForm({ ...fullForm(), linkTemplates: [{ name: 'Template:A', param: '', displayParam: '', valueSeparator: '' }] }).join('；'), /缺少可用的参数位/);
});

test('表单校验：只有空行的显式页面框不算有页面来源', () => {
	assert.match(validateLinkConfigForm({ ...fullForm(), pages: [''], namespaces: [] }).join('；'), /至少要有显式页面/);
	assert.match(validateLinkConfigForm({ ...fullForm(), pages: ['   ', '\t'], namespaces: [] }).join('；'), /至少要有显式页面/);
});

test('表单校验：「从」与「到」归一化后相同（下划线当空格）也判为相同', () => {
	assert.match(validateLinkConfigForm({ ...fullForm(), replacements: [{ from: '苹果 梨', to: '苹果_梨' }] }).join('；'), /「从」与「到」相同/);
});
