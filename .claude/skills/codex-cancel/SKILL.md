---
name: codex-cancel
description: 取消正在运行的 Codex 后台任务。当用户想停止、取消、中断 codex 任务时触发。触发词包括 "/codex-cancel"、"取消 codex"、"停掉 codex"、"别让 codex 跑了"
---

# codex-cancel — 取消 Codex 任务

取消当前仓库中正在运行的 Codex 后台任务。

## 触发词

精确匹配：
- "/codex-cancel"

意图匹配：
- 取消/停掉/中断/停止/别跑了/算了 + codex
- "别让 codex 跑了"、"codex 不用做了"、"把 codex 停了"

## 参数

| 参数 | 说明 |
|------|------|
| `[job-id]` | 指定要取消的任务 ID（可选） |

## 执行步骤

1. 定位插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. 取消任务：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" cancel "$ARGUMENTS"
```

3. 向用户展示取消结果。
