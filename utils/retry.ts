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

export function checkModerationQueued(data: any, message?: string): boolean {
	if (data?.upload?.result === 'Success') {
		return true;
	}
	if (JSON.stringify(data).includes('moderation-image-queued')) {
		if (message) console.log(message);
		return true;
	}
	return false;
}

export function checkModerationQueuedError(error: Error, message?: string): boolean {
	if (error.message && error.message.includes('moderation-image-queued')) {
		if (message) console.log(message);
		return true;
	}
	return false;
}

export function isAbuseFilterError(error: Error): boolean {
	return !!error.message && error.message.toLowerCase().includes('abusefilter');
}
