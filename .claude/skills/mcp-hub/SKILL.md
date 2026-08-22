---
name: mcp-hub
description: 多运行时（claude / codex / grok）共享能力的 MCP Hub 建设与运维。用于给三家 agent 运行时提供同一套工具、记忆、skills 桥接，以及验证某个运行时能否真正走通 MCP 通道。触发词："MCP Hub"、"跨运行时共享"、"多运行时编排"、"codex 接 MCP"、"grok 接 MCP"、"MCP 连通性验证"、"三家共享记忆/工具"。
---

# mycc MCP Hub

给 `claude` / `codex` / `grok` 三个编码运行时提供**同一套**工具、记忆与 skills 桥接。

## 为什么是 MCP

三家唯一的**共同扩展点**就是 MCP。实测能力矩阵（2026-08-22，home-studio）：

| 能力 | claude | codex | grok |
|---|:--:|:--:|:--:|
| MCP 客户端 | ✅ | ✅ | ✅ |
| 作为 MCP server 被调用 | ✅ `claude mcp serve` | ✅ `codex mcp-server` | ❌ 无 |
| headless | `-p` | `codex exec` | `-p/--single` |
| 结构化输出 | stream-json | exec-server | `--output-format streaming-json`（ACP NDJSON）+ `--json-schema` |
| 会话恢复 | ✅ | `codex resume` | `--resume` |
| 子代理 | Agent | — | `--agent` / `--agents <JSON>` |
| skills | ✅ | ❌ **无此概念** | ✅ **原生读 cc 的 skills** |

> **关键真值**：`grok inspect` 实测 grok Build 1.0.3 已原生加载 `~/.claude/rules/*.md`、
> `CLAUDE.md`、`AGENTS.md`、`~/.claude/settings.json` 权限、以及 100 个 skills（含 cc 的 `[claude]` 标记项）。
> **规则/skills 共享对 grok 已经是免费的**，只有 codex 需要 MCP 桥。

## 注册（三家语法不同）

```bash
NODE=$(command -v node); SRV=~/mycc/.claude/skills/mcp-hub/scripts/probe-server.mjs
claude mcp add <name> -- "$NODE" "$SRV"    # → ~/.claude.json（project scope，跟 cwd 走）
codex  mcp add <name> -- "$NODE" "$SRV"    # → ~/.codex/config.toml（global）
grok   mcp add <name>    "$NODE" "$SRV"    # → ~/.grok/config.toml（user scope，无 `--`）
```

## 验收姿势（判据必须防假阳性）

`probe-server.mjs` 返回一个**客户端猜不到的 magic**，且服务端独立记账到 `~/.mycc-mcp/probe-calls.log`。
**两边都要看**——只看模型自述会被虚构叙事骗到（实测 grok 声称"未连上、我改为直接调用"，
而服务端日志显示它明明 `initialize` + `tools/call` 了；信数据不信叙事）。

```bash
# 服务端视角（唯一裁判）：谁真的走了 MCP 通道
grep -oE 'client=[a-z-]+' ~/.mycc-mcp/probe-calls.log | sort | uniq -c
```

判据自检：**不调用工具时必须拿不到 magic**（负向锚），否则判据没有区分力。

## 已知坑

- **cwd 决定成败**：claude 的 MCP 是 project scope，codex 要求 trusted/git 目录。
  在 `~/mycc` 外跑会得到"没连上"的假象（服务端日志会是空的，可据此区分）。
- **codex exec 下 MCP 工具需要审批**：默认 `approval policy = never` 会直接拒
  （报 `MCP tool call requires approval, but approval policy is never`）。
  `exec` **没有** `-a/--ask-for-approval`（那是交互模式的），`-c approval_policy='"on-request"'`
  在无人值守下必然 `BLOCKED`。可用 `--approve-for-me`。
- **codex 吃代理必卡死**：网关只能直连，调用前 `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy`。
- **grok 会重写 config.toml 并丢弃全部注释**（`grok mcp add` 之后自己写的注释就没了），别把说明写在里面。
- **grok 的默认模型不是 config.toml 字段**，是 TUI Settings 项（"Model used for new sessions"）。
  headless 场景一律显式 `-m <配置名>`。
- **grok 模型配置名不能与内置模型同名**，否则冲突。

- 🔴 **grok 的 folder-trust：把 server 归档进仓库反而会让 grok 拒绝启动它**。
  grok 判定仓库内路径为 "repo-local (project-scoped) server"，未信任目录下**静默不启动**——
  症状是 grok 满世界找工具、耗时 3 分钟以上、最后说"没挂上"，而 claude/codex 同路径完全正常。
  诊断：`grok mcp doctor` 会直说 `✗ folder untrusted → re-run with --trust`。
  解法：headless 调用加 `--trust`。加上后 8 秒完成（对照：不加时 3m26s 空转）。
  对照锚：同一份 doctor 里 `mcp-search`（路径在仓库外）是 `✓ server started`，可用来确认不是 server 本身坏了。

## CPA 网关接入真值

凭据取自 Vaultwarden 条目「个人 CPA apikey」——注意它是 **Secure Note（type=2）**，
值在 `notes` 字段不在 `password`，`vw get password` 取不到是正确行为。
落 `~/.cpa.env`（600），**只进变量/stdin，不进 argv、不 echo**。

```toml
# ~/.codex/config.toml
model = "gpt-5.6-sol"
model_provider = "cpa"
[model_providers.cpa]
name = "CPA Smart Router"
base_url = "https://smart-api.hahaxiong.top/v1"
env_key = "CPA_API_KEY"
wire_api = "responses"      # "chat" 已废弃，写错会让所有 codex task 全挂
```

```toml
# ~/.grok/config.toml —— 段名不带版本号，升级只改 model 值
[model.cpa-grok]
model = "grok-4.6"
base_url = "https://smart-api.hahaxiong.top/v1"
env_key = "CPA_API_KEY"
```

相关：skill `cpa-smart-router`（网关侧运维）、`secrets-vault-ops`（凭据取用）。

## memory-server —— 让三家共享 cc 的长期记忆

`scripts/memory-server.mjs`，只读暴露 A canonical（`~/.claude/projects/-home-hahaxiong83-mycc/memory/`，
实测 862 个 .md）。**codex 和 grok 原本读不到这个库**，接上后可直接检索。

| 工具 | 作用 |
|---|---|
| `memory_search(query, limit)` | 检索，返回文件名 + description + 命中行 |
| `memory_read(name)` | 按文件名读全文（用 search 返回的名字，带不带 `.md` 都行） |

### 渐进降级检索（防系统性假阴性）

多关键词若只做短语匹配会大面积零命中，而**「搜过了没有」会被下游当成结论**，比没有工具更危险。
所以按 **phrase → all-terms → any-term** 依次降级，并把实际生效的模式写进返回：

```
6 file(s) matched "vaultwarden" [match mode: phrase]
5 file(s) matched "探针 生产链路" [match mode: all-terms(2)]     ← 修复前这里是 0
11 file(s) matched "vaultwarden 钟差 bubblewrap" [match mode: any-term(3)]
No memory matched "..." — tried phrase, all-terms and any-term.  ← 真零结果
```

### 已知约束

- frontmatter 覆盖率不全（862 个文件里 `name:` 817 / `description:` 799），缺失时 fallback 到文件名。
- `memory_read` 双重路径校验：字符白名单 `[A-Za-z0-9._-]` + realpath 前缀，`../../etc/passwd` 与 `/etc/passwd` 均被拒（已实测）。
- 只读，不提供写入工具。长期记忆写入仍走 cc 自己的判据。
- 服务端账本 `~/.mycc-mcp/memory-calls.log` 记录每次调用，用于核对"谁真的查过"。

### 注册

```bash
NODE=$(command -v node); MEM=~/mycc/.claude/skills/mcp-hub/scripts/memory-server.mjs
claude mcp add mycc-memory -- "$NODE" "$MEM"
codex  mcp add mycc-memory -- "$NODE" "$MEM"
grok   mcp add mycc-memory    "$NODE" "$MEM"
```

实测端到端（2026-08-22）：codex `gpt-5.6-sol` 20s、grok `grok-4.6` 8.4s，均返回真实文件名，
服务端账本可见 `client=codex-mcp-client` / `client=grok-shell-mycc-memory` 的 `memory_search` 调用。
