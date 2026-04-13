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

## 全局默认配置（归属声明）

本 skill 管理的 Codex 任务遵循 codex-* 插件统一默认值：

- `model = gpt-5.4`
- `model_reasoning_effort = xhigh`
- `service_tier = fast`（仅能在 `~/.codex/config.toml` 设置）

完整规则见 `codex-review` / `codex-adversarial-review` 的「全局默认配置（codex 优先要求）」章节。cancel 不直接调模型，但被取消的任务就是这些默认值创建的。

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
