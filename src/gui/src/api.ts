// 前端接口封装骨架：本任务只建基底（错误类型 + 请求助手），
// 具体接口方法与类型由后续任务补齐。所有请求同源（开发时经 Vite 代理），无需配置基地址。

/** 接口错误：携带 HTTP 状态码与服务端返回的错误信息。 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

/** 统一的请求助手：解析 JSON 响应，非 2xx 时抛 ApiError。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	if (!res.ok) {
		let message = `请求失败（${res.status}）`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// 响应体不是 JSON 时沿用默认信息
		}
		throw new ApiError(res.status, message);
	}
	return (await res.json()) as T;
}
