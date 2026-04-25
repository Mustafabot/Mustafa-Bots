export async function withApiRetry(apiCall, options = {}) {
    const { maxRetries = 3, baseDelay = 1000, shouldRetry = () => true, onSuccess, onError, onRetry, } = options;
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const { data } = await apiCall();
            if (onSuccess) {
                const result = onSuccess(data);
                if (result !== null) {
                    return result;
                }
            }
            return data;
        }
        catch (error) {
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
            }
            else {
                break;
            }
        }
    }
    throw lastError || new Error('重试失败');
}
export function checkModerationQueued(data, message) {
    if (data?.upload?.result === 'Success') {
        return true;
    }
    if (JSON.stringify(data).includes('moderation-image-queued')) {
        if (message)
            console.log(message);
        return true;
    }
    return false;
}
export function checkModerationQueuedError(error, message) {
    if (error.message && error.message.includes('moderation-image-queued')) {
        if (message)
            console.log(message);
        return true;
    }
    return false;
}
export function isAbuseFilterError(error) {
    return !!error.message && error.message.toLowerCase().includes('abusefilter');
}
