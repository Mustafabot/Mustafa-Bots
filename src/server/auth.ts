import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 服务配置，全部来自环境变量 */
export interface ServerConfig {
	host: string;
	port: number;
	password?: string;
}

/** 从环境变量读取配置；GUI_PASSWORD 可缺省 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	return {
		host: env.GUI_HOST || '127.0.0.1',
		port: Number.parseInt(env.GUI_PORT || '8787', 10),
		password: env.GUI_PASSWORD || undefined,
	};
}

export function isLoopbackHost(host: string): boolean {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * 请求 `Host` 头（形如 `localhost:8787`、`[::1]:8787`）的主机部分是否属于本机回环。
 *
 * 无口令模式下的 DNS 重绑定防护：恶意页面可把自己的域名解析到 127.0.0.1，
 * 再以 `text/plain` 发简单跨站请求（无预检）驱动本服务。只有 Host 确为本机
 * 时才放行，攻击者的域名过不了这一关。
 */
export function isLocalHeaderHost(host: string): boolean {
	const hostname = host.trim().toLowerCase();
	if (hostname === '') return false;
	// 带端口的 IPv6 字面量必须形如 `[::1]:8787`，主机部分在方括号内
	if (hostname.startsWith('[')) {
		const close = hostname.indexOf(']');
		return close !== -1 && hostname.slice(1, close) === '::1';
	}
	// 无点且多冒号：裸 IPv6 字面量（不带括号时没有端口写法），须整体比较，
	// 否则下面的端口切分会把 `::1` 切成空串
	const colonCount = (hostname.match(/:/g) ?? []).length;
	let bare = hostname;
	if (colonCount <= 1) {
		const colon = hostname.lastIndexOf(':');
		if (colon !== -1) bare = hostname.slice(0, colon);
	}
	return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

/**
 * `Origin` / `Referer` 头（完整 URL）的主机部分是否属于本机回环。
 * 解析失败或非 HTTP(S) 协议一律视为不可信。
 */
export function isLocalOriginUrl(header: string): boolean {
	let url: URL;
	try {
		url = new URL(header);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	// WHATWG URL 的 hostname 对 IPv6 返回带方括号的 `[::1]`，先剥掉再比较
	const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
	return isLoopbackHost(hostname);
}

/**
 * 绑定守卫：非本机地址必须有口令，否则拒服务。
 * 一个持有机器人凭据的服务裸奔在局域网上，被扫到就是灾难。
 */
export function assertSafeBind(host: string, password: string | undefined): void {
	if (isLoopbackHost(host)) return;
	if (!password) {
		throw new Error(`绑定到非本机地址 ${host} 时必须设置 GUI_PASSWORD 环境变量`);
	}
}

/** 定时安全比较，避免按字符提前返回泄露口令长度与内容 */
export function verifyPassword(input: string, expected: string): boolean {
	if (expected === '' || input === '') return false;
	const inputBuffer = Buffer.from(input, 'utf-8');
	const expectedBuffer = Buffer.from(expected, 'utf-8');
	if (inputBuffer.length !== expectedBuffer.length) return false;
	return timingSafeEqual(inputBuffer, expectedBuffer);
}

export function issueToken(): string {
	return randomBytes(32).toString('hex');
}
