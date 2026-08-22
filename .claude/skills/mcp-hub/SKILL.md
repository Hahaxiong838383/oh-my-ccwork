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
- **grok 默认模型 = `[models]` 段下的 `default`**（2026-08-22 实测确认）：

  ```toml
  [models]
  default = "cpa-grok"     # 指向 [model.<名>] 定义的配置名
  ```

  ⚠️ 我一度写成"默认模型只能在 TUI Settings 里点、不是配置字段"——**那是错的**，
  当时试了顶层 `default_model` 和 `[defaults] model` 两个猜的字段名都不生效就下了结论。
  顶层 `default_model = "..."` 是 **Kimi CLI** 的格式（H 平台 `writeKimiConfig` 里那套
  `[providers."x"]` + `[models."y"]` 同理），**对 grok 无效**——照抄会让自定义模型直接从
  `grok models` 列表里消失。别把两家的 schema 混起来。
  🔴 **钉死一个不存在的模型名，grok 会静默 fallback 到池子第一个**，不报错、trace 零观测
  （H 平台真实事故：钉了已下架的 `grok-code-fast-1`，全租户智力降级无人发现）。
  所以改完必须验实际生效，别只看配置文件。
  验证判据（本机可复用）：没跑过 `grok login` 时，内置模型必报 `not authenticated`，
  而走 CPA 的自定义模型有 key 能跑通——**不带 `-m` 直接实跑一次**即可区分是生效还是 fallback。
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

## handoff-server —— 跨运行时交接

`scripts/handoff-server.mjs`。让 A 引擎干到一半的活被 B 引擎接住。

| 工具 | 作用 |
|---|---|
| `handoff_capture(objective, ...)` | 存交接包；**仓库事实由 server 自己跑 git 采集** |
| `handoff_load(id?)` | 取交接包（省略 id = 最新），渲染成可直接消费的文本 |
| `handoff_list(limit)` | 列出交接包，最新在前 |

### 核心设计：按数据来源劈开字段

原方案把 `changedFiles` / `commandsRun` 也交给 LLM 填，但多数运行时 `supportsStructuredTrace=false`，
那样会退化成**「LLM 从终端刷屏里猜自己刚才干了啥」**，而交接质量正是整个方案的价值所在。

所以：

- **机器采集区**：branch / HEAD / headSubject / dirty 清单 / diffstat / upstream ahead-behind
  —— server 直接跑 git，**不接受调用方自述**。
- **自述区**：objective / decisions / open questions / next steps / risks / do-not-do。

渲染时两区分开，且各自带标题声明证据等级
（`MACHINE-COLLECTED (trust these over the narrative)` vs `SELF-REPORTED — treat as claims`）。
接收方据此判断可信度，也能靠对照发现"自述说改了 X 但 git 里没有"这类矛盾。

### 实测（2026-08-22 端到端）

codex `gpt-5.6-sol` 调查 → `handoff_capture`（66s）→ grok `grok-4.6` `handoff_load`（12.3s）接住，
准确复述目标、报出机器采集的 `main @ ae4ee8b3`、接到 codex 留的 next_step。

### 实现要点（都是自测时踩出来的）

- git 子进程必须 `stdio: ['ignore','pipe','ignore']`——**catch 挡得住返回值，挡不住 stderr 继承**，
  否则非 git 目录会往终端喷 `fatal: 不是 git 仓库`。
- id 含毫秒（`YYYYMMDDHHmmssSSS-xxxx`）：同一秒内连开两个包时秒级时间戳会撞。
- 落盘走 `写 .tmp → rename` 原子替换。
- `handoff_load` 的 id 走字符白名单，`../../../etc/passwd` 被拒（已实测）。
- `objective` 为空直接报错——没有目标的交接包不可执行。

## mycc-run —— 三家统一调用入口

`scripts/mycc-run.sh`，symlink 在 `~/.local/bin/mycc-run`（**单一副本，别再复制一份出去**）。

```bash
mycc-run grok   "总结 README"
mycc-run codex  -C ~/mycc "看看 mcp-hub 有哪些脚本"
echo "长 prompt" | mycc-run claude
mycc-run grok -n "..."        # dry-run，只打印真实命令
mycc-run doctor               # 检查三家就绪状态
```

选项：`-m 模型` / `-C 目录` / `-n dry-run` / `--safe`（不自动批准工具）/ `-h`。

### 它收敛掉的四类差异（都是实测踩出来的，靠记是记不住的）

1. **代理方向相反**：codex/grok 走 CPA 必须 `env -u` 剥掉全部代理（吃到代理必卡死）；
   claude 走境外 API **必须保留**代理。同一台机器上两个相反的要求。
2. **审批 flag 三家三样**：`--approve-for-me` / `--always-approve` / `--permission-mode bypassPermissions`。
3. **grok 的 `--trust`**：仓库内的 MCP server 不加它就静默不启动（`--safe` 模式也保留它——
   trust 不是审批，是 MCP 加载前提，去掉就等于没有工具）。
4. **grok 必须显式 `-m`**：默认模型是 TUI 设置项不是配置字段，headless 不给就回落内置 grok-4.5。

### doctor

9 项检查（CLI 安装 / 凭据存在与 600 权限 / CPA_API_KEY 非空 / 网关直连 / 两家 MCP 注册）。
**已做负向验证**：把 `MYCC_CPA_ENV` 指向不存在的文件，凭据三项转 ✗ 且退出码 1；
正常时 0 ✗ 退出码 0——确认它不是恒绿的自检。

实测：三家经 wrapper 均返回预期结果；grok 经 wrapper 调 `memory_search` 服务端账本可见。

## 🔴 codex 模型钉定：项目级 config 会盖掉用户级，而 doctor 只看用户级

`~/.codex/config.toml` 写 `model = "gpt-5.6-sol"`、`codex doctor` 回显 `model gpt-5.6-sol · cpa`
——**照样没生效**。实跑 `codex exec` 打印的是 `model: gpt-5.3-codex`。

根因：codex 有配置分层，**项目级 `<repo>/.codex/config.toml` 覆盖用户级**
（官方 config-reference：项目级可覆盖 model，但**不能**覆盖 `model_provider` / `model_providers` / auth）。
本仓 `.codex/config.toml` 第一行就是 `model = "gpt-5.3-codex"` + `model_reasoning_effort = "high"`，
且**它是 git 跟踪的**（从 Mac 同步来的，里面 MCP server 全是 `/Users/rayman.chen/` 路径）。

**为什么极难发现**：
- `provider: cpa` 是对的（项目级盖不了 provider），只有 model 被换 → 看起来"配置生效了大半"；
- `doctor` 报的是用户级配置 → **诊断工具与运行时看的不是同一层**，全绿而实际没生效；
- codex 对不存在的模型名不做本地校验（`-m definitely-not-a-real-model-xyz` 原样接受），
  所以"名字被换掉"不可能是校验拒绝，只可能是被别处覆盖。

**定位手法（可复用）**：`grep -rl '<实际生效的值>' ~/.codex/ <repo>/` ——直接问"谁持有这个值"，
比逐层读配置快得多；再拿配置里写的值做对照锚，看两者分别落在哪个文件。

**解法**：`-c model="..."` 优先级最高，压得住项目级。`mycc-run` 已内置
（`CODEX_MODEL_DEFAULT`，可用 `MYCC_CODEX_MODEL` 环境变量改）。
**已根治（2026-08-22）**：项目级 `.codex/config.toml` 里的 `model` 行已移除。
实测两端用户级都是 `gpt-5.6-sol`，删掉后各机器回落到自己的用户级——
Air 侧同样受益（它此前也被这行静默覆盖：mycc 目录内 rollout 记录是 `gpt-5.3-codex`，
而目录外是 `gpt-5.6-sol`，正是项目级配置的作用域语义）。
**模型选择跟机器/账号走，不跟仓库走**——跨机同步的仓库不该钉具体模型。
`mycc-run` 的 `-c model=` 保留为显式兜底。

## 让「直接敲 grok / codex」也能用（不经 mycc-run）

配好 `[models] default` 只解决了"用哪个模型"，还差"钥匙在哪"：`env_key` 读的是**环境变量**，
干净 shell 里没有 `CPA_API_KEY` 时 grok 会退回要求 `grok login`（codex 同理）。

`~/.bashrc` 加载凭据，⚠️ **必须放在「非交互 return」guard 之前**：

```bash
# 位置：case $- in *i*) ;; *) return;; esac  之前
[ -r "$HOME/.cpa.env" ] && { set -a; . "$HOME/.cpa.env"; set +a; }
```

放 guard 之后只有交互式终端生效，`ssh home-studio 'grok -p ...'` 这类**非交互调用会静默读不到 key**。
同一个坑这台机器踩过两次——`.bashrc` 里 rustup 那段旁边就留着 2026-08-21 的注释
（`ssh host 'cargo build'` 读不到 PATH），是同一个成因。

验证要跑**三种形态**，别只验最省事的那个：

| 形态 | 命令 |
|---|---|
| 交互式 | `bash -ic 'echo ${#CPA_API_KEY}'` |
| 非交互 | `bash -c '. ~/.bashrc; echo ${#CPA_API_KEY}'` |
| 真实 ssh | 从另一台机 `ssh <host> 'echo ${#CPA_API_KEY}'` |

`ssh localhost` 做这个验证会撞 `Host key verification failed`——那是测试环境问题不是功能问题，
**别把它读成"功能没生效"**，要么修 known_hosts，要么从真的另一台机器发起。

顺带一条实测修正：**grok 带代理能正常跑**（3.7s，xray 对 `hahaxiong.top` 走了直连分流），
不像 codex 那样吃代理必卡死。mycc-run 里对 grok 的 `env -u` 是多余的保险，留着无害。

## codeg —— 自托管多引擎 GUI（2026-08-22 装于 home-studio）

`xintaofei/codeg`（Apache-2.0，★2.9k，Rust+Tauri+Next.js，56.7 万行）的 **server 模式**。
home-studio 无 GUI，所以跑 headless server，从 Air 浏览器访问——顺带把"远程"这条也验了。

### 部署真值

| 项 | 值 |
|---|---|
| 二进制 | `~/.local/bin/codeg-server` + `~/.local/bin/codeg-mcp`（v0.27.0，装在用户目录，无需 sudo） |
| 数据 | `~/.local/share/codeg/`（`codeg.db` / `logs/` / `web/`） |
| 端口 | 3080，**自动监听全部接口**（127.0.0.1 / 192.168.1.133 / 10.10.10.23） |
| 认证 | token，存 `~/.local/share/codeg/token`（0600），首启生成后持久化在 DB |
| 服务 | `systemctl --user codeg-server`，`EnvironmentFile=%h/.cpa.env` |
| linger | 已 `loginctl enable-linger`，ssh 断开后继续跑 |

### 装的时候踩到/避开的

- `codeg-server --help` **不是帮助参数，它会直接把服务器跑起来**（还会在当前 cwd 建 `out/`
  当 fallback static dir）。查配置别用 `--help`，看 `install.sh` 的提示。
- 装之前审了 `install.sh`（505 行）：下载源只有 3 个官方 URL，`rm -rf` 仅一处 trap 清理临时目录，
  19 处 sudo 都在"目标目录不可写才提权"分支——所以 `CODEG_INSTALL_DIR=~/.local/bin` 全程不提权。
  **别直接 `curl | bash`。**
- **不要用 Docker**：容器会挡住 codeg 调用宿主的 claude/codex/grok CLI 与 `~/.claude/skills`、`~/.mycc-mcp`。
- systemd **不读 `~/.bashrc`**，CPA 凭据必须走 `EnvironmentFile`，否则 codeg 拉起的 codex/grok
  会因 `env_key` 找不到而认证失败。

### MCP 自动发现

`POST /api/mcp_scan_local`（Bearer token）会扫 `.claude` / `.claude.json` / `.codex` / `.cursor` / `.gemini`
的 MCP 配置——**不扫 `.grok`**。实测自动扫到 `mycc-probe` / `mycc-memory` / `mycc-handoff`，
`apps=codex,grok`，无需在 codeg 里手工注册。

### ACP 适配器（首次进 UI 会报"适配器尚未安装"）

codeg 走 ACP，**不直接用本地 CLI**，claude/codex 需各自的 npx 适配器；**grok 原生支持 ACP，不需要**。

| agent_type | registry | 适配器 |
|---|---|---|
| `claude_code` | `claude-acp@0.69.0` | 需要 |
| `codex` | `codex-acp@1.4.0` | 需要（**不是 `codex_cli`**） |
| `grok` | `grok-build@1.0.5` | 不需要（`is_acp_adapter=false`） |

命令行安装（省得在 UI 点）：

```bash
T=$(cat ~/.local/share/codeg/token)
curl -s --noproxy '*' -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"agentType":"claude_code","taskId":"install-1"}' \
  http://127.0.0.1:3080/api/acp_prepare_npx_agent
```

⚠️ 入参是 **camelCase**（`agentType` / `taskId`），且 `taskId` 必填——错了它会明确告诉你缺哪个字段，
**照错误信息改比猜快**。agent_type 真值一律从 `POST /api/acp_list_agents` 取，别按显示名猜。

其他有用端点：`acp_env_diagnostics`（UI 那个"诊断"按钮）、`acp_preflight`、
`acp_respond_permission` / `acp_answer_plan_approval`（**codeg 的审批体系，正是我们自己缺的那块**）。
npm registry 本机直连可达（200），装适配器不需要代理。

### token

已入密码库条目 **`codeg server token (home-studio)`**（Login 类型，URI 已填两个访问地址）。
本机备份 `~/.local/share/codeg/token`(0600)。重启服务不变（持久化在 codeg.db）。

```bash
systemctl --user status codeg-server        # 状态
ssh <host> 'cat ~/.local/share/codeg/token' # 取登录 token
```

---

## 三家的审计与守门能力（2026-08-22 实证调研，别再写「未知」）

### 一张表

| | 会话/命令记录 | 守门（能拦） | 失败事件 | 本机状态 |
|---|---|---|---|---|
| **cc** | `PostToolUse` hook 自建（`tool-audit.sh`） | ✅ `PreToolUse` 可 `permissionDecision:deny` | ✅ `PostToolUseFailure` | 已接线，4 条 hook |
| **codex** | ✅ **rollout 默认全记**（命令原文+输出） | ❌ hooks **不能拦**，守门走 exec policy | ❌ **无该事件** | rollout 默认开，hooks/rules 未启用 |
| **grok** | 未调研 | hooks 可 `exit 2` 真拦（matcher `run_terminal_command`） | 未调研 | 未接线 |

### codex：审计比 cc 更全，而且默认就在记

**别再给 codex 造审计——它自带。** 要做的只是「读」。

- 位置 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`，**默认开启**
  （判据：`grep -cE 'rollout|history|log_dir|hooks' ~/.codex/config.toml` = **0**，而文件照样在长）。
- 每行 `{ordinal, timestamp, type, payload}`。`type` 分布：
  `response_item`（`message` / `reasoning` / `custom_tool_call`+`_output` / `function_call`+`_output`
  / `tool_search_call`+`_output`）、`event_msg`（`item_completed` / `token_count` / `task_started` …）、
  `session_meta` / `turn_context` / `world_state`。
- `custom_tool_call` 的 `name` 恒为 `exec`，字段 `call_id,id,input,name,status,type`——
  **`input` 是命令原文**（实测 75–464 字符），`output` 最长实测 20,610 字符。
  MCP 调用走 `function_call`，`arguments` 里是完整参数。
- 另有 `~/.codex/logs_*.sqlite` 的 `logs` 表（Rust tracing 内部诊断，含
  `codex_core::exec_policy`），**不是审计日志**，别混。

⚠️ 取数用 `sqlite3` 时本机没有该命令，走 `python3 -c` 的 `sqlite3` 模块，
**URI 必须带 `?mode=ro`** 免得写坏 codex 正在用的库；且别边迭代游标边查询（会重置迭代器）。

### codex 的 hooks 拿不来当守门用

官方文档原话（`learn.chatgpt.com/docs/config-file/config-reference`）：

> Command hooks are currently supported; prompt and agent hook handlers are parsed but skipped.
> **Hooks receive data but cannot block operations** … run after decisions are made, not as gatekeepers.

事件名（已逐个在 0.148.0 二进制对撞，命中 29–108 次）：`PreToolUse` `PermissionRequest`
`PostToolUse` `PreCompact` `PostCompact` `SessionStart` `SessionEnd` `SubagentStart`
`SubagentStop` `UserPromptSubmit` `Stop`。**`PostToolUseFailure` 命中 0 —— codex 没有这个事件**
（用最宽子串匹配得到的 0 才算可靠阴性）。启用需 `features.hooks`。

### 要给 codex 加拦截 → 写 rules，不是 hooks

`~/.codex/rules/default.rules`（用户层）/ Team Config（管理员）/ `<repo>/.codex/rules/`（需 trusted）。
`prefix_rule()` 字段：`pattern`（必填）、`decision` = **`allow` | `prompt` | `forbidden`**、
`justification`、`match`/`not_match`。优先级 **forbidden > prompt > allow**。
它会把 `&&`/`||`/`;`/`|` 链拆开逐条评估（含变量/重定向的复杂脚本按单条处理）。

`no-guessing-guard.sh` 里 deny 的四条（`git add -A`、`pkill -f`、`git reset --hard`、
commit 署名）都能翻译成 `prefix_rule`，这是给 codex 补守门的正确方向。

### 企业级：`/etc/codex/requirements.toml`

`allow_managed_hooks_only = true` 可让管理员层 hooks 生效、忽略 user/project/session 的。
⚠️ **文档自相矛盾**：`learn.chatgpt.com` 的 config-reference **完全没提** `requirements.toml`；
而 GitHub `openai/codex` 的 `docs/config.md` 与二进制字符串都有它。
**两个独立源对一个源，按证据判定它存在**，官网那页大概是消费者视角。

### 其它可配的审计项（本机均未启用）

`log_dir`（默认 `$CODEX_HOME/log`，设了还会开 `codex-tui.log` 明文日志）、
`[history] persistence = "save-all|none"` + `history.max_bytes`（写 `history.jsonl`）、
`notify`（外部通知命令，收 JSON payload）、`[analytics] enabled`。
