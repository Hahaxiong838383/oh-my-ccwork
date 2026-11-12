# 2026-11-12 REA 技能升级与本地运维技能落地

- 时间：2026-11-12 12:50 CST
- 引擎：DSH（DeepSeek Harness）会话，工作目录 `~/mycc/2-Projects/rea`
- 上游来源：[morluto/rea](https://github.com/morluto/rea) commit `a01674377f1f2a0fed467035fddc25e90e74d75a`（2026-11-12，`package.json` 6.8.0，技能 `version: "62"`，8 个 reference）
- 本机包版本未变：`rea-agents@6.7.0`（未升级，理由见下）

## 做了什么

1. **把上游源码 main 的技能完整导出到三个技能根**（原为发布包技能 v42、7 文件）：
   `~/.agents/skills/reverse-engineer-anything`、`~/.claude/skills/reverse-engineer-anything`、`~/.hermes/skills/reverse-engineer-anything`，现为 v62 + 8 reference（新增 `desktop-build.md` 860 行、`environments.md` 399 行）。
   - 仅一处构建等价替换：`npx -y rea-agents@latest` → `@6.7.0`（与官方 `scripts/generate-skill-metadata.mjs` 的"钉版本"行为一致，避免拉到本机跑不起来的 6.8.0）。其余与上游逐字节一致。
   - 旧 v42 备份：`/tmp/rea-skill-v42-backup-20261112-125113.tgz`。
2. **新增本地运维技能 `rea`**（三个技能根同步）：安装真值、MCP/CLI/npx 三通道、DSH 接入细则、provider 能力现状、路由速查、Evidence 预算、排障阶梯、升级回滚、验收清单。
   - `references/tool-catalog.md`：用 `rea --mcp` 的 `tools/list` 实测导出 **207** 个工具（含 1 行描述，按 12 类分组）。
   - `references/cli-commands.md`：`rea --help` 实测 **155** 条命令全表。
   - `references/env-vars.md`：235 个 `REA_*` 中筛出运行时相关的约 60 个并分组。
   - `references/version-alignment.md`：6.7.0 / 6.8.0(npm) / main 三方对照，列出 **v62 提到但本机没有的 38 个工具** 与 6.8.0 破坏性变更。
   - `references/troubleshooting.md`：症状→处置表、客户端/服务端超时分界、本机已知状态。

## 观察（实测）

- `rea doctor --client dsh --json`：`identity.skill.installed_version = "62"`、`state = "stale"`（包期望 42），`remediation` 建议跑 `rea setup`。
- 注册状态：`claude_code` / `codex` / `gemini_cli` / `grok_build` / `hermes` 已对齐；`cursor`、`dsh` 缺。**当前 DSH 会话没有 `mcp__rea__*` 工具**。
- provider：`ghidra`（未设 `GHIDRA_INSTALL_DIR`，且 PATH 无 `java`）、`hopper`（`/opt/hopper/bin/Hopper` 不存在）、`ida`、`jadx`、`kuna` 全不可用；内置 provider（artifact graph / dotnet static / sqlite 等）可用。
- 6.7.0 catalog 计数：`cli_commands 153`、`mcp_tools 207`、`mcp_prompts 6`；`--help` 列 155 条（差 2 为 `completions`、`mcp` 集成入口）。

## 判断

- 技能 v62 描述的是 main 的能力面，本机 38 个工具不存在。已在 `rea` 技能的 `version-alignment.md` 列清单，并要求调用前以 `tools/list`/目录为准；上游 SKILL.md 本身也声明"main 的技能可能描述旧包没有的能力"。
- 未升级到 6.8.0：其 engines 为 `^22.23.4 || ^24.22.1 || >=26.12.1`，本机专用运行时是 **24.22.0**，差一个补丁号。升级路径已写进 `rea` 技能第 9 节（先换 Node 再 `rea update`）。
- `doctor` 报 `stale` 是预期，不是故障；不要因此跑 `rea setup`（那会把技能降回包内 42 并重写客户端配置）。

## 追加：DSH 注册落地（2026-11-12 13:00）

同一会话内按用户要求执行 `rea setup --client dsh --yes`，结果为 `ready`（`configured_dsh` + `installed_skill`）。

- 生成 `~/dsh-stack/home/cordis.patch.yml`（原先不存在），entry：`rea-mcp` → `@deepseek-ai/dsh-mcp-client`，`serverName: rea`，`command: /home/hahaxiong83/.local/bin/rea`，`args: [mcp]`；另加 `toolCallTimeoutMs: 600000`（DSH 默认 60s，对 REA 偏短）。改动前备份 `cordis.patch.yml.pre-timeout.bak`。
- `dsh --profile acp --dump-config` 已包含该 entry（439 行组合树），说明 home patch 被加载。
- **`rea setup` 会覆盖技能**：实测把 `~/.agents/skills/reverse-engineer-anything` 的 SKILL.md + 6 个同名 reference 换成 v42，旧文件留成 `*.rea.backup`，v62 独有的两个新 reference 反而残留 → 混合目录（16 文件）。已从快照 `~/.local/share/rea/skill-snapshot-20261112/reverse-engineer-anything-v62.tgz` 完整还原，三根重新一致（9 文件 / v62）。该行为已写进 `rea` 技能第 9 节。
- `rea doctor --client dsh --json`：registration `aligned`，`healthy: true`。
- **实测挂载**：主 Web 实例（PID 1585306，端口 3090）在配置写入后约 1 分钟自动 spawn `rea mcp`（PID 1652396，12:56:08），父子通过 socketpair 连接、状态稳定未重启 → HMR 热加载生效，无需重启 web 服务。
- **端到端**：用注册文件里的原样命令起 stdio，完成 initialize → `tools/list` 返回 **207** 个工具（含 `analyze_javascript_application`、`open_binary`）；`binary_session` 正常返回；对 `/tmp/rea-smoke` 两文件 JS 工程跑 `analyze_javascript_application`（summary）成功返回 Evidence（575ms）。
- 界限：**当前 ACP 会话（PID 1642581）没有 `rea mcp` 子进程**——它在配置写入前启动，`dsh-mcp-client` 是每进程挂载，会话内工具表不会热增。要在此类会话里用工具需新起会话/进程。

## 未验证 / 边界

- ~~未重启 Harness~~ → 已由 HMR 覆盖 Web 实例；ACP 旧进程仍需新建会话才能拿到工具（见上）。
- ~~未在 Web UI 里发一条真实对话来验证模型侧看到 `mcp__rea__*`~~ → 由并行的 GUI 会话完成：`mcp__rea__binary_session` 返回完整 provider 与能力清单，`mcp__rea__get_evidence_bundle` 返回空 bundle（未做分析，正常），catalog `tools_sha256` 与本目录记录一致。
- `dsh --profile headless` 在本轮结束前仍报 `MISSING_CREDENTIAL: llm-deepseek`（`.credentials.yaml` 只有 `client-connection/browser-session`，没有 `llm-deepseek-api-key`）——说明 GUI 端添加的模型凭证当时还没落到该文件，或加在了别的通道。要用 headless 需确认凭证落点，不要从别处猜 key。
- 未验证 v62 里 38 个新工具的真实行为（本机没有该版本）。
- 未对任何真实目标做分析取证；本次只做技能与文档。
