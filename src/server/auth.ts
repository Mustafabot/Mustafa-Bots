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
