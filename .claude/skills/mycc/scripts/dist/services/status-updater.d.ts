/**
 * Status 自动更新器
 *
 * 定时从系统实时状态生成 0-System/status.md，
 * 确保飞书通道 hooks 注入的始终是最新信息。
 *
 * 触发时机：
 * 1. 后端启动时立即执行一次
 * 2. 每 30 分钟自动刷新
 * 3. 定时任务完成后刷新
 */
export declare function addStatusEvent(event: string): void;
/**
 * 刷新 status.md
 */
export declare function refreshStatus(cwd: string): void;
/**
 * 启动 status 定时更新
 */
export declare function startStatusUpdater(cwd: string): void;
/**
 * 停止 status 定时更新
 */
export declare function stopStatusUpdater(): void;
//# sourceMappingURL=status-updater.d.ts.map