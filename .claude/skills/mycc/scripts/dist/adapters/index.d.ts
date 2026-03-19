/**
 * Adapter 导出
 *
 * 默认使用官方 Claude Code SDK 实现
 * 魔改版可以替换为自己的实现
 */
import { OfficialAdapter } from "./official.js";
import type { CCAdapter } from "./interface.js";
export type { CCAdapter, SSEEvent } from "./interface.js";
export declare const adapter: CCAdapter;
export declare const officialAdapter: OfficialAdapter;
export { OfficialAdapter };
//# sourceMappingURL=index.d.ts.map