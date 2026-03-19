/**
 * AI Agent 自省调试框架
 *
 * 来源：EvoMap Capsule `gene_agent_introspection_debugging` (GDI 68.8)
 * 触发词：agent_error, auto_debug, self_repair, error_fix, runtime_exception
 *
 * 功能：
 * 1. 全局错误捕获 - 拦截未捕获异常和工具调用错误
 * 2. 根因分析 - 基于规则库匹配 80%+ 常见错误
 * 3. 自动修复 - 自动创建缺失文件、修复权限、安装依赖、避免限流
 * 4. 自省报告 - 无法修复时通知人类
 */
import { FeishuChannel } from './channels/feishu.js';
/**
 * 错误类型分类
 */
export type ErrorCategory = 'file_not_found' | 'permission_denied' | 'network_timeout' | 'rate_limit' | 'dependency_missing' | 'syntax_error' | 'unknown';
/**
 * 错误分析结果
 */
export interface ErrorAnalysis {
    category: ErrorCategory;
    message: string;
    solution: string;
    canAutoRepair: boolean;
    repairAttempted: boolean;
    repairSuccess: boolean;
}
/**
 * 自省报告
 */
export interface IntrospectionReport {
    timestamp: string;
    error: Error;
    analysis: ErrorAnalysis;
    repairAttempts: string[];
    finalStatus: 'resolved' | 'failed' | 'needs_human';
}
/**
 * AI Agent 自省调试模块
 */
export declare class AgentIntrospection {
    private feishu;
    private errorLog;
    private maxLogSize;
    private rules;
    constructor(feishuChannel?: FeishuChannel);
    /**
     * 设置飞书通道（用于发送通知）
     */
    setFeishuChannel(channel: FeishuChannel): void;
    /**
     * 分析错误并尝试自动修复
     */
    analyze(error: Error): Promise<ErrorAnalysis>;
    /**
     * 包装异步函数，自动捕获和分析错误
     */
    wrapAsync<T extends (...args: any[]) => Promise<any>>(fn: T, context?: string): (...args: Parameters<T>) => Promise<ReturnType<T> | null>;
    /**
     * 通知人类（通过飞书）
     */
    private notifyHuman;
    /**
     * 记录错误日志
     */
    private logError;
    /**
     * 获取错误统计
     */
    getStats(): {
        total: number;
        resolved: number;
        failed: number;
        needsHuman: number;
    };
    /**
     * 获取最近错误日志
     */
    getRecentErrors(limit?: number): IntrospectionReport[];
}
/**
 * 全局单例
 */
export declare const agentIntrospection: AgentIntrospection;
//# sourceMappingURL=introspection.d.ts.map