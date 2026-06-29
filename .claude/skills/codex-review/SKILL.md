---
name: codex-review
description: 让 Codex 对当前 git 工作区或分支进行代码审查。当用户提到让 codex/openai 审查、review、看看代码、检查代码时触发。触发词："/codex-review"、"codex 审查"、"让 codex 看看代码"、"找 codex 审查"、"用 codex review"
---

# codex-review — Codex 代码审查

调用 Codex 对本地 git 状态进行标准代码审查。仅审查，不修改代码。

## 触发词

精确匹配：
- "/codex-review"

意图匹配（包含以下任意关键词组合即触发）：
- codex/openai + 审查/review/看看代码/检查代码/查一下代码
- 让/找/用/启动 + codex + 审/看/检查
- "codex 帮忙看看代码"、"找 codex review 一下"

## 参数

| 参数 | 说明 |
|------|------|
| `--wait` | 前台等待结果 |
| `--background` | 后台运行 |
| `--base <ref>` | 指定对比基准分支（如 `--base main`） |
| `--scope auto\|working-tree\|branch` | 审查范围 |

## 执行步骤

1. 定位插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. **如果用户未指定 `--wait` 或 `--background`**，先评估审查规模：
   - 工作区审查：运行 `git status --short --untracked-files=all`、`git diff --shortstat --cached`、`git diff --shortstat`
   - 分支审查：运行 `git diff --shortstat <base>...HEAD`
   - 未追踪文件/目录也算可审查内容
   - 1-2 个文件且无大范围变更 → 推荐前台等待
   - 其他情况 → 推荐后台运行
   - 询问用户选择「等待结果」或「后台运行」

3. **前台执行**：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" review --model gpt-5.5 "$ARGUMENTS"
```

4. **后台执行**：

```bash
# 使用 run_in_background: true
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" review --model gpt-5.5 "$ARGUMENTS"
```
后台启动后告知用户：「Codex 审查已在后台启动，用 `/codex-status` 查看进度。」

5. **结果展示**：原样返回 Codex 输出，不要解读、总结或修改。

## 铁律

- **必须带 `--model gpt-5.5`**：codex companion 走 ChatGPT 订阅账号，不支持默认的 `gpt-5.3-codex`（报 400 `The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account`）。上面命令已固定 `--model gpt-5.5`（账号支持的无 `-codex` 后缀模型），**切勿删除**。如需换模型，只能用 `gpt-5.4`/`gpt-5.5` 等无 `-codex` 后缀的。
- **仅审查，不修复**。不要根据审查结果自动修改代码。
- **原样输出**。不要改写、总结或添加评论。
- 如果用户需要自定义审查指令或更激进的审查，引导使用 `/codex-adversarial-review`。
