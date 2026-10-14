import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeBind, isLoopbackHost, verifyPassword, issueToken } from './auth.js';

test('识别本机回环地址', () => {
	assert.equal(isLoopbackHost('127.0.0.1'), true);
	assert.equal(isLoopbackHost('localhost'), true);
	assert.equal(isLoopbackHost('::1'), true);
	assert.equal(isLoopbackHost('0.0.0.0'), false);
	assert.equal(isLoopbackHost('192.168.1.9'), false);
});

test('绑定本机时无口令也放行', () => {
	assert.doesNotThrow(() => assertSafeBind('127.0.0.1', undefined));
});

test('绑定非本机且无口令时抛错', () => {
	assert.throws(() => assertSafeBind('0.0.0.0', undefined), /GUI_PASSWORD/);
	assert.throws(() => assertSafeBind('192.168.1.9', ''), /GUI_PASSWORD/);
});

test('绑定非本机且有口令时放行', () => {
	assert.doesNotThrow(() => assertSafeBind('0.0.0.0', '一个足够长的口令'));
});

test('口令比对正确', () => {
	assert.equal(verifyPassword('abc', 'abc'), true);
	assert.equal(verifyPassword('abc', 'abd'), false);
	assert.equal(verifyPassword('abc', 'abcd'), false);
	assert.equal(verifyPassword('', ''), false);
});

test('每次签发的令牌都不同且长度足够', () => {
	const a = issueToken();
	const b = issueToken();
	assert.notEqual(a, b);
	assert.ok(a.length >= 32);
});
