/**
 * 通用可执行文件路径探测器
 *
 * 设计目标：
 * - 可扩展：新增探测策略只需添加一个函数
 * - 可测试：依赖注入 ResolveContext，纯单元测试无需 mock 模块
 * - 可复用：Claude CLI 和 cloudflared 共用同一套探测链
 *
 * 策略链（按优先级执行，首个成功即返回）：
 * - envVar(name)         → 环境变量覆盖
 * - npmGlobal(pkg, entry) → npm root -g 动态探测（跨平台）
 * - knownPaths(paths)    → 平台特定已知路径
 * - whichCommand(name)   → which/where 命令
 * - fallback(name)       → 裸命令名兜底
 */
/** 探测结果 */
export interface ResolveResult {
    /** 执行命令（如 "node"、"claude"、"cloudflared"） */
    executable: string;
    /** 完整路径（如 "/path/to/cli.js"） */
    path: string;
}
/** 依赖上下文（可注入，方便测试） */
export interface ResolveContext {
    env: Record<string, string | undefined>;
    platform: string;
    existsSync: (path: string) => boolean;
    execSync: (cmd: string, opts?: {
        encoding: BufferEncoding;
    }) => string;
}
/** 探测策略函数 */
export type ResolveStrategy = (ctx: ResolveContext) => ResolveResult | null;
/**
 * 按顺序执行策略链，返回第一个成功的结果
 * 所有策略都失败时返回 null
 */
export declare function resolveExecutable(strategies: ResolveStrategy[], ctx: ResolveContext): ResolveResult | null;
/**
 * 环境变量策略
 * 用户通过环境变量显式指定路径，最高优先级
 */
export declare function envVar(varName: string): ResolveStrategy;
/**
 * which/where 命令策略
 * Mac/Linux 用 which，Windows 用 where
 */
export declare function whichCommand(name: string): ResolveStrategy;
/**
 * npm 全局包策略
 * 使用 `npm root -g` 动态获取全局模块路径，跨平台兼容（nvm/volta/标准安装）
 */
export declare function npmGlobal(packageName: string, entryFile: string): ResolveStrategy;
/**
 * 已知路径策略
 * 检查平台特定的常见安装路径
 *
 * @param paths 路径列表或返回路径列表的函数（惰性求值）
 * @param options.executable 指定可执行命令名（如 "node"、"claude"）
 *        不指定时：.js 文件自动用 "node"，其他用路径本身
 */
export declare function knownPaths(paths: string[] | ((ctx: ResolveContext) => string[]), options?: {
    executable?: string;
}): ResolveStrategy;
/**
 * 兜底策略
 * 总是成功，返回裸命令名（依赖系统 PATH）
 */
export declare function fallback(name: string): ResolveStrategy;
//# sourceMappingURL=resolve-executable.d.ts.map