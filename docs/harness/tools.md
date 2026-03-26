# 工具与依赖规则

> 从 CLAUDE.md 解耦的工具模块。定义工具选择策略和依赖管理。

---

## 工具选择优先级

| 场景 | 首选 | 降级方案 |
|------|------|---------|
| 桌面自动化 | Ghost OS MCP（`ghost_*` 系列） | `/desktop` skill |
| 安装部署 | Bash（`git clone` → 编译 → 配置） | Pencil 仅用于流程编排 |
| 复杂任务（>10min） | 自动调用 Codex（`mcp__x__ask_codex`） | cc 自行执行 |
| 搜索调研 | Gemini（`mcp__g__ask_gemini`） | 本地搜索 |

---

## 依赖本地化规则

所有外部依赖安装到项目根目录，不依赖系统 PATH 或全局安装。

理由：
- 多设备同步时不依赖各机器的全局环境
- 版本一致性
- 可重现的构建

---

## 多设备协作

- 共享的（git）：CLAUDE.md、skills、文档
- 本地的（gitignore）：`.env`、`settings.local.json`、二进制、`current.json`
- OS 差异由 `platform.ts` 运行时处理

详见 [`docs/setup-guide.md`](../setup-guide.md)。
