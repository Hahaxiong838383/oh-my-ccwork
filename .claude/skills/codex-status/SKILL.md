---
name: codex-status
description: 查看 Codex 任务状态。显示当前 session 的活跃/近期 Codex 任务，包括审查门状态。触发词："/codex-status"、"codex 状态"、"任务进度"、"codex 跑完了吗"
layer: 工具层
authorization: A区（自动执行，不等人确认）
output_levels: L1（简洁输出）
---

# codex-status — Codex 任务状态

> 查看当前 session 的活跃和近期 Codex 任务。

## 触发词

- `/codex-status`
- "codex 状态"、"任务进度"、"codex 跑完了吗"
- "看看 codex"、"review 完了吗"

---

## 全局默认配置（归属声明）

本 skill 追踪的 Codex 任务运行在 codex-* 插件统一默认值下：

- `model = gpt-5.4`
- `model_reasoning_effort = xhigh`
- `service_tier = fast`（仅能在 `~/.codex/config.toml` 设置）

完整规则见 `codex-review` / `codex-adversarial-review` 的「全局默认配置（codex 优先要求）」章节。status 表格中若看到非 gpt-5.4 model，说明 task 被显式覆盖，需在输出中标注。

---

## 执行

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" status $ARGUMENTS
```

### 参数

- 无参数：显示当前 session 所有任务概览
- `[job-id]`：显示指定任务的详细信息
- `--wait`：等待任务完成
- `--timeout-ms <ms>`：超时时间
- `--all`：显示所有任务（不限当前 session）

---

## 输出规则

### 无 job-id 时

渲染为 **Markdown 表格**，保持紧凑：

| 字段 | 说明 |
|------|------|
| Job ID | 任务标识 |
| Kind | 类型（review/adversarial-review/task） |
| Status | 状态（running/completed/failed） |
| Phase | 当前阶段 |
| Elapsed | 耗时 |
| Summary | 简要说明 |
| Follow-up | 可用的后续命令 |

不要在表格外添加额外说明。

### 有 job-id 时

原样展示完整输出，不要总结或压缩。
