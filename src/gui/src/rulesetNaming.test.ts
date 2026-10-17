// 规则集命名的单元测试：只测纯逻辑，不依赖 React 或网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configPageFor } from './rulesetNaming';

test('预设名拼出默认配置页标题', () => {
	assert.equal(configPageFor('替换地区用语'), 'User:没有羽翼的格雷塔/BotConfig/替换地区用语');
});

test('没起名字时给出空前缀，不拼出半个页面名', () => {
	assert.equal(configPageFor(''), 'User:没有羽翼的格雷塔/BotConfig/');
	assert.equal(configPageFor('   '), 'User:没有羽翼的格雷塔/BotConfig/');
});
