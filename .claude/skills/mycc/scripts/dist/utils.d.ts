/**
 * 工具函数
 */
/** 生成 6 位配对码/连接码 */
export declare const generateCode: () => string;
/** 生成 6 位 token（同 generateCode） */
export declare const generateToken: () => string;
/** 生成 12 位设备 ID */
export declare const generateDeviceId: () => string;
/**
 * 通用重试函数
 * @param fn 要执行的异步函数，返回 null/undefined 表示失败
 * @param options 重试配置
 * @returns 成功的结果或 null
 */
export interface RetryOptions {
    maxRetries: number;
    delayMs: number;
    onRetry?: (attempt: number, error?: string) => void;
}
export declare function retryWithBackoff<T>(fn: () => Promise<T | null>, options: RetryOptions): Promise<T | null>;
/**
 * 等待某个条件就绪（主动探测）
 * @param checkFn 检查函数，返回 true 表示就绪
 * @param options 配置
 * @returns 是否就绪
 */
export interface WaitForReadyOptions {
    maxWaitMs: number;
    intervalMs: number;
    onCheck?: (attempt: number) => void;
}
export declare function waitForReady(checkFn: () => Promise<boolean>, options: WaitForReadyOptions): Promise<boolean>;
//# sourceMappingURL=utils.d.ts.map