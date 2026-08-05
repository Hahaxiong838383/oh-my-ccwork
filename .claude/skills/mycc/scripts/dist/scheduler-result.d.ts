import type { Task } from "./scheduler.js";
export declare const SCHEDULER_RESULT_PREFIX = "SCHEDULER_RESULT";
export declare const SCHEDULER_UNKNOWN_SUMMARY = "\u26A0\uFE0F \u5F15\u64CE\u5B8C\u6210\uFF0C\u4E1A\u52A1\u7ED3\u679C\u672A\u77E5";
export type SchedulerBusinessStatus = "success" | "failed" | "skipped" | "unknown";
export interface SchedulerBusinessResult {
    status: SchedulerBusinessStatus;
    summary: string;
    error?: string;
}
export interface SchedulerNotificationSink {
    sendOwnerP2P(text: string): Promise<boolean>;
    sendGroup?(text: string): Promise<boolean>;
}
export interface SchedulerNotificationResult {
    target: "owner_p2p" | "group";
    delivered: boolean;
}
export declare function buildSchedulerPrompt(task: Task, timestamp: string): string;
export declare function extractSchedulerEventText(event: Record<string, unknown>): string;
export declare function parseSchedulerResult(output: string): SchedulerBusinessResult;
export declare function schedulerEngineErrorResult(summary: string, error: unknown): SchedulerBusinessResult;
export declare function formatSchedulerHistoryStatus(result: SchedulerBusinessResult): string;
export declare function formatSchedulerNotification(taskName: string, timestamp: string, result: SchedulerBusinessResult): string;
export declare function sendSchedulerResultNotification(task: Pick<Task, "name" | "desc">, timestamp: string, result: SchedulerBusinessResult, sink: SchedulerNotificationSink): Promise<SchedulerNotificationResult>;
export declare function isGroupNotificationOptIn(desc: string): boolean;
export declare function sanitizeSchedulerText(input: string, maxLength?: number): string;
//# sourceMappingURL=scheduler-result.d.ts.map