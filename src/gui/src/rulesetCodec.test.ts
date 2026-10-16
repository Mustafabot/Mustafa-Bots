// 规则编解码的单元测试：只测纯逻辑，不依赖 React 或网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRuleset, encodeRuleset, type RuleFormState } from './rulesetCodec';

test('表单状态与规则集 JSON 互转可逆', () => {
	const form: RuleFormState = { rules: [{ from: '苹果', to: '梨', regex: true, ignoreCase: false }], namespaces: [0] };
	assert.deepEqual(decodeRuleset(encodeRuleset(form)), form);
});

test('坏掉的 JSON 与缺字段都退回可用的默认值', () => {
	assert.deepEqual(decodeRuleset('不是 JSON'), { rules: [], namespaces: [] });
	assert.deepEqual(decodeRuleset('{"rules":[{"from":"a"}]}'), { rules: [{ from: 'a', to: '', regex: false, ignoreCase: false }], namespaces: [] });
});
