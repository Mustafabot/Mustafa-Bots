export interface RetryOptions<T> {
	maxRetries?: number;
	baseDelay?: number;
	shouldRetry?: (error: Error, attempt: number) => boolean;
	onSuccess?: (data: any) => T | null;
	onError?: (error: Error, attempt: number) => void;
	onRetry?: (attempt: number, delay: number) => void;
}

export async function withApiRetry<T>(
	apiCall: () => Promise<any>,
	options: RetryOptions<T> = {}
): Promise<T> {
	const {
		maxRetries = 3,
		baseDelay = 1000,
		shouldRetry = () => true,
		onSuccess,
		onError,
		onRetry,
	} = options;

	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const { data } = await apiCall();

			if (onSuccess) {
				const result = onSuccess(data);
				if (result !== null) {
					return result;
				}
			}

			return data as T;
		} catch (error: any) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (onError) {
				onError(lastError, attempt);
			}

			if (attempt < maxRetries && shouldRetry(lastError, attempt)) {
				const delay = baseDelay * attempt;

				if (onRetry) {
					onRetry(attempt, delay);
				}

				await new Promise(resolve => setTimeout(resolve, delay));
			} else {
				break;
			}
		}
	}

	throw lastError || new Error('重试失败');
}

export interface ApiError {
	code: string;
	info: string;
}

/** MediaWiki 的错误既可能以 error/errors 出现在 200 响应体里，也可能被 wiki-saikou 抛出 */
export function extractApiError(data: any): ApiError | null {
	if (data?.error?.code) {
		return { code: String(data.error.code), info: String(data.error.info ?? '') };
	}
	const first = Array.isArray(data?.errors) ? data.errors[0] : undefined;
	if (first?.code) {
		return { code: String(first.code), info: String(first.text ?? first['*'] ?? '') };
	}
	return null;
}

/** Moderation 扩展的入队响应码（moderation-image-queued / moderation-move-queued 等） */
const MODERATION_QUEUED_RE = /moderation-[a-z]+-queued/;

/** 判断文本是否为 Moderation 扩展的「已入审核队列」响应码 */
export function isModerationQueuedCode(text: string): boolean {
	return MODERATION_QUEUED_RE.test(text);
}

/** 判断错误是否为权限不足（permissiondenied），重试无意义，应立即终止 */
export function isPermissionDeniedError(error: Error | { message?: string } | string): boolean {
	const msg = typeof error === 'string' ? error : (error.message ?? '');
	return msg.toLowerCase().includes('permissiondenied');
}

export function checkModerationQueued(data: any, message?: string): boolean {
	if (data?.upload?.result === 'Success') {
		return true;
	}
	if (isModerationQueuedCode(JSON.stringify(data))) {
		if (message) console.log(message);
		return true;
	}
	return false;
}

export function checkModerationQueuedError(error: Error, message?: string): boolean {
	if (error.message && isModerationQueuedCode(error.message)) {
		if (message) console.log(message);
		return true;
	}
	return false;
}

export function isAbuseFilterError(error: Error): boolean {
	return !!error.message && error.message.toLowerCase().includes('abusefilter');
}
