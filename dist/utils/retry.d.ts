export interface RetryOptions<T> {
    maxRetries?: number;
    baseDelay?: number;
    shouldRetry?: (error: Error, attempt: number) => boolean;
    onSuccess?: (data: any) => T | null;
    onError?: (error: Error, attempt: number) => void;
    onRetry?: (attempt: number, delay: number) => void;
}
export declare function withApiRetry<T>(apiCall: () => Promise<any>, options?: RetryOptions<T>): Promise<T>;
export declare function checkModerationQueued(data: any, message?: string): boolean;
export declare function checkModerationQueuedError(error: Error, message?: string): boolean;
export declare function isAbuseFilterError(error: Error): boolean;
