---
name: codex-result
description: 获取 Codex 任务结果。显示已完成 Codex 任务的最终输出，包括 verdict、findings、artifacts。触发词："/codex-result"、"codex 结果"、"审查结果"、"review 结果"
layer: 工具层
authorization: A区（自动执行，不等人确认）
output_levels: L3（完整输出）
---

# codex-result — Codex 任务结果

> 获取已完成 Codex 任务的最终存储输出。

## 触发词

- `/codex-result`
- "codex 结果"、"审查结果"、"review 结果"
- "看看 codex 的输出"

---

## 全局默认配置（归属声明）

本 skill 读取的 Codex 任务结果来自 codex-* 插件统一默认值产生的运行：

- `model = gpt-5.4`
- `model_reasoning_effort = xhigh`
- `service_tier = fast`（仅能在 `~/.codex/config.toml` 设置）

完整规则见 `codex-review` / `codex-adversarial-review` 的「全局默认配置（codex 优先要求）」章节。若 result 输出中看到非 gpt-5.4 的 model 字段，说明有人覆盖了默认，需告知用户。

---

## 执行

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" result $ARGUMENTS
```

### 参数

- `[job-id]`：指定任务 ID（可选，默认最近一次）

---

## 输出规则

**完整展示**，不要总结或压缩。保留所有细节：

- Job ID 和状态
- 完整结果载荷：verdict、summary、findings、details、artifacts、next steps
- 文件路径和行号（原样保留）
- 错误消息或解析错误
- 后续命令提示（如 `/codex-status <id>`、`/codex-review`）

### findings 按 severity 排序

1. critical
2. high
3. medium
4. low

每个 finding 保留：severity、title、body、file、line_start/line_end、confidence、recommendation
