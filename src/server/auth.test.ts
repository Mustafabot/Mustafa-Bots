import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeBind, isLocalHeaderHost, isLocalOriginUrl, isLoopbackHost, verifyPassword, issueToken } from './auth.js';

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

test('Host 头只放行本机名，可带端口', () => {
	assert.equal(isLocalHeaderHost('localhost'), true);
	assert.equal(isLocalHeaderHost('localhost:8787'), true);
	assert.equal(isLocalHeaderHost('127.0.0.1'), true);
	assert.equal(isLocalHeaderHost('127.0.0.1:8787'), true);
	assert.equal(isLocalHeaderHost('[::1]'), true);
	assert.equal(isLocalHeaderHost('[::1]:8787'), true);
	assert.equal(isLocalHeaderHost('::1'), true);
	assert.equal(isLocalHeaderHost('LOCALHOST:8787'), true);
	// DNS 重绑定：攻击者自己的域名解析到 127.0.0.1 也必须被挡下
	assert.equal(isLocalHeaderHost('evil.example.com'), false);
	assert.equal(isLocalHeaderHost('evil.example.com:8787'), false);
	assert.equal(isLocalHeaderHost('127.0.0.2'), false);
	assert.equal(isLocalHeaderHost('127.0.0.1.evil.com'), false);
	assert.equal(isLocalHeaderHost(''), false);
});

test('Origin/Referer 头只放行指向本机的 URL', () => {
	assert.equal(isLocalOriginUrl('http://localhost:8787/'), true);
	assert.equal(isLocalOriginUrl('http://127.0.0.1:8787/'), true);
	assert.equal(isLocalOriginUrl('http://[::1]:8787/'), true);
	assert.equal(isLocalOriginUrl('https://localhost/'), true);
	assert.equal(isLocalOriginUrl('http://evil.example.com/'), false);
	assert.equal(isLocalOriginUrl('http://evil.example.com:8787/'), false);
	assert.equal(isLocalOriginUrl('null'), false);
	assert.equal(isLocalOriginUrl(''), false);
});
