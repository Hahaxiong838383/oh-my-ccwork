/**
 * Adapter 导出
 *
 * 默认使用官方 Claude Code SDK 实现
 * 魔改版可以替换为自己的实现
 */
import { OfficialAdapter } from "./official.js";
// 导出默认 adapter 实例（保留具体类型，方便访问 checkAuth 等扩展方法）
const _adapter = new OfficialAdapter();
export const adapter = _adapter;
export const officialAdapter = _adapter;
// 也导出类，方便需要自定义配置的场景
export { OfficialAdapter };
//# sourceMappingURL=index.js.map