---
name: codex-review
description: Codex 代码审查。对本地 git 变更运行 Codex 代码审查，支持前台/后台模式。触发词："/codex-review"、"代码审查"、"review 一下"、"帮我 review"、"code review"
layer: 分析层
authorization: A区（自动执行，不等人确认）
output_levels: L3（原样输出 Codex 结果）
---

# codex-review — Codex 代码审查

> 基于 OpenAI Codex CLI 插件，对本地 git 工作区变更进行自动化代码审查。

## 触发词

- `/codex-review`
- "代码审查"、"review 一下"、"帮我 review"、"code review"
- "让 codex 看看代码"、"跑个 review"

---

## 全局默认配置（codex 优先要求）

**所有 codex-* skills 共享的强制默认值**，cc 不得擅自更改：

| 配置项 | 值 | 设置位置 | 覆盖方式 |
|--------|----|----|----|
| `model` | `gpt-5.4` | 命令行 `--model` + `~/.codex/config.toml` | 用户显式 `--model <other>` |
| `model_reasoning_effort` | `xhigh` | `~/.codex/config.toml` | 仅能改 config.toml |
| `service_tier` | `fast` | `~/.codex/config.toml` | 仅能改 config.toml |

**启动前自检**（任何 codex 调用第一次运行时跑一次）：

```bash
grep -E "^(model|model_reasoning_effort|service_tier)" ~/.codex/config.toml
```

期望输出：

```
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
service_tier = "fast"
```

缺失或漂移时，cc **必须先补齐 config.toml 再执行 review**，并在输出中说明补齐动作。用户显式要求其他 model / effort 时才可偏离默认。

---

## 前置检查

运行前先确认 Codex CLI 可用：

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" setup --json
```

如果 `ready: false`，提示用户先运行 `/codex:setup`。

---

## 核心约束

- **仅审查，不修复。** 不要修改代码、应用补丁或暗示即将修改。
- 唯一职责：运行审查并将 Codex 输出**原样**返回给用户。
- 不要释义、总结或添加评论。

---

## 执行模式

### 参数处理

用户可传入参数：`$ARGUMENTS`

支持的参数：
- `--wait`：前台执行，等待结果
- `--background`：后台执行
- `--base <ref>`：指定基准分支
- `--scope auto|working-tree|branch`：审查范围

### 模式选择

1. 如果参数包含 `--wait` → 直接前台运行
2. 如果参数包含 `--background` → 直接后台运行
3. 否则，先估算审查规模：
   - 运行 `git status --short --untracked-files=all`
   - 运行 `git diff --shortstat --cached` 和 `git diff --shortstat`
   - 如果审查明显很小（1-2 个文件）→ 推荐前台等待
   - 其他情况（包括不确定）→ 推荐后台
   - 有疑问时运行审查而非声明"无内容可审"
4. 使用 `AskUserQuestion` 询问用户选择

---

## 前台执行

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" review --model gpt-5.4 $ARGUMENTS
```

将 stdout 原样返回。`--model gpt-5.4` 是全局优先默认值，用户 `$ARGUMENTS` 里显式再传 `--model <other>` 时以用户为准（parseArgs 后值覆盖前值）。

## 后台执行

```bash
# 使用 Bash 工具的 run_in_background: true
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" review --model gpt-5.4 $ARGUMENTS
```

启动后告知用户："Codex review 已在后台启动。使用 `/codex-status` 查看进度。"

---

## 输出规则

- 保留 Codex 输出中的所有内容：verdict、summary、findings、file paths、line numbers
- 按 severity 排序展示 findings
- 展示后 **停止** — 不要在未经用户明确批准的情况下修改代码
