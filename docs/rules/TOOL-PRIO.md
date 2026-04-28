# TOOL-PRIO: 工具选择优先级

| 字段 | 值 |
|------|-----|
| 优先级 | P2 |
| 权重 | 0.60 |
| 是否常用 | 可选 |
| 是否必选 | 可选 |
| 触发条件 | 需要操作桌面 / 安装部署 / 执行 >10 分钟难任务时 |

## 动作

- **桌面自动化**：优先 Ghost OS MCP（`ghost_*` 系列），不可用时降级到 `/desktop` skill
- **安装部署**：优先 Bash（`git clone` → 编译 → 配置），Pencil 仅用于流程编排
- **有难度的任务**（>10 分钟）：自动调用 Codex（`mcp__x__ask_codex`）

## Why

- Ghost OS MCP 是结构化 API，比 OCR 触觉的 /desktop 准；后者用于 Ghost 不支持的 GUI
- Bash 比 Pencil 直观可调试；Pencil 优势在多步流程组合
- 长任务交给 Codex 可避免 cc 上下文膨胀，cc 专注规划/决策
