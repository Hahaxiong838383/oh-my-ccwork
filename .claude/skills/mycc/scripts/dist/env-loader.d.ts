/**
 * .env 文件加载 + PUBLIC_URL 检测
 *
 * 公网直连模式的核心：
 * - 读取 .env 文件中的 PUBLIC_URL
 * - 有 PUBLIC_URL → 公网模式（跳过 Tunnel）
 * - 没有 → 内网模式（启动 cloudflared）
 */
/**
 * 解析 .env 文件内容为 key-value 对
 *
 * 支持：
 * - 注释行（# 开头）
 * - 空行
 * - 值的双引号 / 单引号
 * - 值中包含等号
 */
export declare function parseEnvFile(content: string): Record<string, string>;
/**
 * 加载 PUBLIC_URL
 *
 * 优先级：
 *   1. process.env.PUBLIC_URL（环境变量直接传入）
 *   2. searchDirs 中的 .env 文件（按顺序查找，第一个找到即返回）
 *
 * 验证：
 *   - 必须 https:// 开头
 *   - 去除尾部斜杠
 *
 * @param searchDirs 搜索目录列表（按优先级排列）
 * @returns PUBLIC_URL 或 null
 */
export declare function loadPublicUrl(...searchDirs: string[]): string | null;
/**
 * 加载 .env 文件到 process.env
 *
 * 优先级：
 *   1. searchDirs 中的 .env 文件（按顺序查找，第一个找到即加载）
 *   2. 不覆盖已存在的 process.env 变量
 *
 * @param searchDirs 搜索目录列表（按优先级排列）
 */
export declare function loadEnvFile(...searchDirs: string[]): void;
//# sourceMappingURL=env-loader.d.ts.map