/**
 * 端口管理器 — 端口注册表 + 冲突自动换端口 + /ports API 一览
 *
 * 核心能力：
 * 1. 维护已知服务端口注册表（静态 + 动态探测）
 * 2. 启动时检测端口冲突，自动换到冷门端口
 * 3. 提供 getPortsSnapshot() 供 HTTP API 调用
 */
export interface PortEntry {
    port: number;
    service: string;
    owner: "mycc" | "cc-remote" | "system" | "external" | "unknown";
    status: "listening" | "free" | "conflict";
    pid?: number;
    process?: string;
}
/**
 * 检查单个端口是否被占用
 */
export declare function isPortInUse(port: number): {
    inUse: boolean;
    pid?: number;
    process?: string;
};
/**
 * 生成当前端口全景快照
 */
export declare function getPortsSnapshot(): PortEntry[];
/**
 * 为指定服务寻找可用端口
 *
 * 策略：
 * 1. 先尝试首选端口
 * 2. 如果被占用，从冷门端口池中找第一个可用的
 * 3. 都不行就随机选一个高位端口
 */
export declare function findAvailablePort(preferredPort: number): {
    port: number;
    changed: boolean;
};
/**
 * 打印端口一览表（终端美化输出）
 */
export declare function printPortsTable(): void;
//# sourceMappingURL=port-manager.d.ts.map