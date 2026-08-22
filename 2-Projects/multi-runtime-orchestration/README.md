# multi-runtime-orchestration

> 让 **claude / codex / grok** 三个编码运行时共享同一套记忆、工具、skills 与交接机制，
> 并通过自托管 GUI 远程使用。
> **状态：核心链路已跑通并在用（2026-08-22）**，客户端改用现成的 codeg 而非自研。

## 为什么不是原方案那套

起点是一份《多运行时 AI 编码 Agent 桌面端编排系统 · 完整方案设计》（v1.0 + v1.1 评审）。
调研后**大半 Phase 作废**，因为实际地基比方案假设的强得多：

| 原方案要建 | 实际 |
|---|---|
| Tauri/Electron 桌面端 + Runtime 发现启动框架 | 148 行 shell（`mycc-run`）够用；GUI 直接用现成的 codeg |
| 插件 manifest + 插件面板 | codex 有 `openai/skills` ★25k 生态，grok 有 `plugin` 子命令 |
| MCP 聚合层 | 三家原生都是 MCP 客户端 |
| opendray Gateway（★54）/ shellX UI（★16）/ dsh 深度集成 | 全砍，一行没用 |

**关键判断：MCP 是三家唯一的共同扩展点**，一次实现三家可用。

## 现在长什么样

```
接入层   claude / codex / grok        ← 三家都是 MCP 客户端
   │     统一入口 mycc-run（收敛代理方向/审批 flag/模型指定的差异）
   │     GUI: codeg 自托管 @ :3080   ← 从 Air 经 mesh 访问
   ▼
MCP Hub  .claude/skills/mcp-hub/scripts/
   ├─ probe-server.mjs    连通性探针（防"模型自述调用了"的假阳性）
   ├─ memory-server.mjs   A canonical 862 条记忆 → 三家可检索
   └─ handoff-server.mjs  跨运行时交接包（仓库事实机器采集 / 语义部分自述，分区标注）

skills   .claude/skills/（84 真源，唯一权威）
         .agents/skills/（67 指针，codex+grok 读）
         .codex/skills/（45 个 OpenAI 官方）
```

## 关键真值

| 项 | 值 |
|---|---|
| codeg | `http://192.168.1.133:3080`（局域网）/ `http://10.10.10.23:3080`（mesh） |
| codeg 服务 | `systemctl --user codeg-server`，已 enable + linger |
| codeg token | 密码库条目 `codeg server token (home-studio)`；本机 `~/.local/share/codeg/token` |
| 引擎模型 | codex `gpt-5.6-sol` / grok `cpa-grok`→`grok-4.6`，均经 CPA 网关 |
| CPA 凭据 | `~/.cpa.env`(0600)，`.bashrc` 在**非交互 guard 之前**加载 |

运维细节、全部踩坑与验收姿势见 skill **`mcp-hub`**（唯一权威，本文件不复制正文）。

## TODO

1. **远程（Air 侧启用）** — 文件已 pull，MCP 注册 0、`mycc-run` 未建 symlink；凭据要按 Mac 惯例（Keychain / `~/.mycc-secrets.env`）
2. **审计与权限门** — 为跑通 MCP，三家审批我全绕过了（`--approve-for-me` / `--always-approve` / `bypassPermissions`）却没补审计；`~/.mycc-mcp/*.log` 只记 MCP 调用，不记 shell/文件操作。**codeg 自带 `acp_respond_permission` / `acp_answer_plan_approval`，先评估够不够用**
3. **实战检验** — 三个 server 累计 35+ 次调用全是测试，零真实使用
4. **ADB 硬件调试** — 原始需求里有（调试插在笔记本上的安卓开发板），完全没碰；现在有 mesh，可能比方案设想的简单
5. 次要：handoff 自动化（现在靠人记得 capture）、`grok memory`/`plugin`/`trace` 自带能力的复用调研

## 技术债

- `.claude/skills/mycc/scripts/scripts/*.mjs:29` 硬编码 `appToken`、`feishu-mcp/SKILL.md:194` 示例 token（既有，已在 git 历史里，轮换才是真解）
- GitHub PAT 曾在本轮泄漏前缀（川哥决定暂不处理）
- `daily-tech-pulse` 目录只有 `data/` 和 `.env.example`，不是有效 skill

## 备选客户端

`desktop-cc-gui`（★4062，Tauri，52.2 万行，MIT）—— 与 codeg 同栈、功能高度重叠但架构不同
（它自建 engine 层 + `skills_hub.rs`，codeg 走 ACP 标准）。**两者规模都在 50 万行级，不可能融合**。
codeg 用着不顺手时，去翻它的解法作参考，源码分析见 skill `mcp-hub`。
