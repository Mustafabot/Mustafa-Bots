import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargetList } from './targetList.js';

test('普通行当页面，带分类前缀的行统一成 Category: 标题', () => {
	const result = parseTargetList(`
		苹果
		分类:萌娘百科
		Category:Vocaloid
		cat：游戏
	`);
	assert.deepEqual(result.pages, ['苹果']);
	assert.deepEqual(result.categories, ['Category:萌娘百科', 'Category:Vocaloid', 'Category:游戏']);
});

test('空行与首尾空白被去掉，重复项只保留一次', () => {
	const result = parseTargetList('苹果\n\n  苹果 \n\nCategory:X\n  Category:X  \n');
	assert.deepEqual(result.pages, ['苹果']);
	assert.deepEqual(result.categories, ['Category:X']);
});

test('只有前缀没有分类名的行被忽略', () => {
	const result = parseTargetList('Category:\n分类：\n');
	assert.deepEqual(result.pages, []);
	assert.deepEqual(result.categories, []);
});

test('分类前缀只认整行开头，名字里带冒号的普通页面仍是页面', () => {
	const result = parseTargetList('Talk:Category:X\nWikipedia:分类\n');
	assert.deepEqual(result.pages, ['Talk:Category:X', 'Wikipedia:分类']);
	assert.deepEqual(result.categories, []);
});
