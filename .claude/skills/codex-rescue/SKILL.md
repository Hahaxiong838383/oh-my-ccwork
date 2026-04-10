---
name: codex-rescue
description: 将调查、修复或后续任务委派给 Codex 执行。当用户提到让 codex 帮忙做某事、交给 codex、找 codex 协助、启动 codex 干活时触发。这是最通用的 codex 任务入口。触发词包括 "/codex-rescue"、"让 codex 帮忙"、"交给 codex"、"找 codex 协助"、"启动 codex"
---

# codex-rescue — 委派任务给 Codex

将调查、修复、诊断或后续任务委派给 Codex 执行。Codex 拥有独立的代码环境，可以读写文件、运行测试。

## 触发词

精确匹配：
- "/codex-rescue"

意图匹配（用户意图是「让 codex 做某件事」即触发，这是最通用的 codex 任务入口）：
- 让/找/用/启动/叫 + codex + 帮忙/协助/来/做/干/查/修/搞/处理/解决
- 交给/委派给/丢给/扔给 + codex
- codex + 帮我/帮忙 + 任意任务描述
- "找 codex 帮忙查一下为什么报错"、"启动 codex 协助修复"、"让 codex 来搞定这个"
- "codex 帮我写个脚本"、"叫 codex 过来干活"、"交给 codex 处理"

**路由提示**：如果用户意图明确是「审查代码」→ 走 codex-review；「挑毛病」→ 走 codex-adversarial-review；其他所有「让 codex 做事」→ 走本 skill。

## 参数

| 参数 | 说明 |
|------|------|
| `--background` | 后台运行（复杂/开放任务推荐） |
| `--wait` | 前台等待（简单/有界任务推荐） |
| `--resume` | 继续上一个 Codex 线程 |
| `--fresh` | 强制启动新线程 |
| `--model <model\|spark>` | 指定模型（`spark` 映射为 `gpt-5.3-codex-spark`） |
| `--effort <level>` | 推理力度：none/minimal/low/medium/high/xhigh |
| `[task text]` | 要 Codex 执行的任务描述 |

## 执行步骤

1. 定位插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. **如果用户没指定 `--resume` 或 `--fresh`**，检查是否有可恢复的线程：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" task-resume-candidate --json
```

   - 如果 `available: true`，询问用户「继续当前 Codex 线程」还是「启动新线程」
   - 如果用户在做后续指令（"继续"、"keep going"、"深入查"），推荐继续
   - 否则推荐启动新线程
   - 用户选继续 → 添加 `--resume`；选新线程 → 添加 `--fresh`

3. **如果用户未提供任务描述**，先询问要 Codex 做什么。

4. **执行任务**：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" task "$ARGUMENTS"
```

   - `--background`/`--wait` 是执行控制标志，不转发给 task 命令
   - `--model`/`--effort` 保留转发
   - `--resume`/`--fresh` 保留转发
   - 默认使用 `--write`（可写模式），除非用户明确要求只读

5. **结果展示**：原样返回 Codex stdout，不解读、不总结、不添加评论。

## 铁律

- cc 只做转发，不做独立分析。不要在发送 Codex 之前自己读文件、查 grep。
- 不要在 Codex 运行后主动轮询 status、获取 result、取消任务。
- 原样返回输出。如果 Bash 调用失败，不返回任何内容。
- 不设 `--effort` 除非用户明确要求。
- 不设 `--model` 除非用户明确要求。
