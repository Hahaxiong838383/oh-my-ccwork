/**
 * 配置管理
 */
import type { DeviceConfig } from "./types.js";
/**
 * 获取配置目录（统一逻辑）
 * 优先级：MYCC_SKILL_DIR > cwd/.claude/skills/mycc > ~/.mycc/
 */
export declare function getConfigDir(cwd: string): string;
/**
 * 加载设备配置（从 current.json）
 */
export declare function loadConfig(cwd: string): DeviceConfig | null;
/**
 * 删除设备配置（用于 --reset）
 */
export declare function deleteConfig(cwd: string): void;
/**
 * 自动查找项目根目录
 * 从当前目录向上查找，直到找到包含 .claude/ 或 claude.md (不区分大小写) 的目录
 */
export declare function findProjectRoot(startDir: string): string | null;
//# sourceMappingURL=config.d.ts.map