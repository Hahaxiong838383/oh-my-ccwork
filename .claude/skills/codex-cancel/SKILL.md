---
name: codex-cancel
description: 取消 Codex 后台任务。终止正在运行的 Codex 后台任务。触发词："/codex-cancel"、"取消 codex"、"停止审查"、"cancel codex"
layer: 工具层
authorization: A区（自动执行，不等人确认）
output_levels: L1（简洁输出）
---

# codex-cancel — 取消 Codex 任务

> 终止正在运行的 Codex 后台任务。

## 触发词

- `/codex-cancel`
- "取消 codex"、"停止审查"、"cancel codex"
- "别 review 了"、"取消任务"

---

## 执行

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" cancel $ARGUMENTS
```

### 参数

- `[job-id]`：指定要取消的任务 ID（可选）

---

## 输出规则

原样展示命令输出。取消成功后简要确认。
