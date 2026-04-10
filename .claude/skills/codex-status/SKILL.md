---
name: codex-status
description: 查看 Codex 后台任务的状态和进度。当用户问 codex 跑得怎么样、进度如何、做完没时触发。触发词包括 "/codex-status"、"codex 状态"、"codex 跑到哪了"、"codex 做完没"
---

# codex-status — Codex 任务状态

查看当前仓库中活跃和最近的 Codex 任务状态，包括 review-gate 状态。

## 触发词

精确匹配：
- "/codex-status"

意图匹配：
- codex + 状态/进度/跑到哪了/做完没/好了吗/怎么样了
- "codex 那边啥情况"、"看看 codex 进度"、"codex 搞完没"

## 参数

| 参数 | 说明 |
|------|------|
| `[job-id]` | 查看特定任务的详情 |
| `--wait` | 等待任务完成 |
| `--timeout-ms <ms>` | 等待超时时间 |
| `--all` | 显示所有任务（包括已完成的） |

## 执行步骤

1. 定位插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. 运行状态查询：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" status "$ARGUMENTS"
```

3. **结果展示**：
   - 无 job-id：渲染为紧凑的 Markdown 表格（包含 job ID、类型、状态、阶段、耗时、摘要、后续命令）
   - 有 job-id：完整展示该任务的详细信息，不要压缩
