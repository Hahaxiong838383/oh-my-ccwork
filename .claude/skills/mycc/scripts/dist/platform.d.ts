/**
 * 跨平台工具函数
 * 集中处理 Windows / Mac / Linux 的差异
 *
 * 路径探测使用 resolve-executable.ts 的通用策略链
 */
export declare const isWindows: boolean;
/** 空设备路径：Windows: NUL, Mac/Linux: /dev/null */
export declare const NULL_DEVICE: string;
export declare function sleep(ms: number): Promise<void>;
/**
 * 获取路径的根目录
 * Mac/Linux: "/"  Windows: "C:\\"
 */
export declare function getRoot(filePath: string): string;
export declare function killPortProcess(port: number): Promise<void>;
/**
 * 检测 cloudflared 路径
 * 策略链：环境变量 → 已知路径 → which/where → 裸命令名
 */
export declare function detectCloudflaredPath(): string;
/**
 * 检测 Claude CLI 路径
 * 策略链：环境变量 → npm root -g → 已知 cli.js 路径 → which/where → 已知 native 路径 → 裸命令名
 *
 * 返回 { executable, cliPath }：
 * - npm 安装：{ executable: "node", cliPath: "/path/to/cli.js" }
 * - native 安装：{ executable: "claude", cliPath: "/path/to/claude" }
 */
export declare function detectClaudeCliPath(): {
    executable: string;
    cliPath: string;
};
export declare function getCloudflaredInstallHint(): string;
/**
 * 检查 Claude Code CLI 是否可用
 * 使用 detectClaudeCliPath 的结果，不硬编码命令名
 */
export declare function checkCCAvailable(): Promise<boolean>;
/**
 * 检查 cloudflared 是否可用
 */
export declare function checkCloudflared(): Promise<boolean>;
//# sourceMappingURL=platform.d.ts.map