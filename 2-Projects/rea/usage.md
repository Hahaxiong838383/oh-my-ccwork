# REA 本机调用指南（各智能体共用）

> 2026-10-21 已安装：REA 6.7.0、独立Node24.22.0。仅home-studio，不代表Air/Mini/NAS已安装。安装真值见 installation.json；验收见 reports/2026-10-21-acceptance.json。
> **2026-11-12 技能更新**：`reverse-engineer-anything` 升到源码 main 的 v62（8 reference），另加本地运维技能 `rea`（含 207 工具目录/155 CLI 命令/排障/升级）。doctor 报 skill `stale` 属预期。

## 何时使用

当任务涉及已发布应用/二进制、ASAR/Electron/JavaScript产物、版本行为差异或反编译时使用。完整源码仓的普通架构分析仍用rg等代码工具。始终使用用户指定/授权目标，不自行选生产进程做动态注入。

## 优先调用已连接的MCP

六个客户端（含 DeepSeek Harness）的全局配置均注册名 `rea`，启动命令 `/home/hahaxiong83/.local/bin/rea mcp`。DSH 走 `~/dsh-stack/home/cordis.patch.yml` 的 `rea-mcp` 条目，工具名 `mcp__rea__*`。新会话读取配置；安装前已经运行的会话可能需要重新连接，期间可用下方CLI。不要每次任务重复setup或doctor。

在客户端实际工具列表找到 `analyze_javascript_application`（Hermes本轮名称为 `mcp__rea__analyze_javascript_application`），示例：

```json
{"input_path":"/absolute/path/to/app","format":"directory","detail":"summary"}
```

**MCP参数是 `input_path`，不是 `path`**；ASAR可用 `format:"asar"` 或实际schema支持的 `auto`。始终按当前工具schema。summary返回后，按实际 `parent_evidence_id` 在同一连接调用 `inspect_analysis_view`，分页查看模块/关系；不要反复重新分析同一目标。结论保留Evidence ID、输入SHA-256、覆盖率和limitations。

## 所有支持shell的智能体都能使用CLI

```bash
/home/hahaxiong83/.local/bin/rea --version
/home/hahaxiong83/.local/bin/rea analyze-javascript-application /absolute/path/to/app --json
```

CLI路径是位置参数；它直接返回Evidence。大结果写到目标项目批准的报告路径再读取。普通shell也可直接 `rea`；绝对路径适合Codeg、定时任务或精简PATH环境。使用本机已安装入口，避免默认Node22.14下直接运行 `npx rea-agents`。入口内部固定独立Node并补充进程内PATH，不修改系统Node。

需要诊断时才执行：

```bash
/home/hahaxiong83/.local/bin/rea doctor --client codex --json
/home/hahaxiong83/.local/bin/rea doctor --client hermes --json
```

客户端ID：Claude=`claude_code`、Codex=`codex`、Grok=`grok_build`、Hermes=`hermes`、Gemini=`gemini_cli`。其他智能体先用CLI/共享技能，按真实客户端支持再配置，不能声称本轮已验证所有引擎。

## 技能及记忆入口

- 官方技能：`~/.agents/skills/reverse-engineer-anything/SKILL.md`（Codex/Grok/Gemini共享），`~/.claude/skills/reverse-engineer-anything/SKILL.md`，`~/.hermes/skills/reverse-engineer-anything/SKILL.md`。
- 三份现为**源码 main 技能 v62**（9 文件，2026-11-12 导出，来源 commit `a016743`；唯一改动是 `@latest`→`@6.7.0`）。旧发布包技能 v42 备份：`/tmp/rea-skill-v42-backup-20261112-125113.tgz`（/tmp 不持久，需要长期留档时另存）。
- 本地运维技能 `rea`：同三个技能根下的 `rea/SKILL.md`，讲安装真值、接入、207 工具索引、排障、升级回滚；分析方法论仍看 `reverse-engineer-anything`。
- 版本红线：v62 描述的部分工具（38 个）本机 6.7.0 **没有**，调用前以 `rea/references/tool-catalog.md` 或 `tools/list` 为准。
- 共享记忆：`~/mycc/0-System/memory-items.md` 的REA安装/调用条目及 `RECENT_EVENTS.md`。查询 `memory_search rea-agents` 或 `memory_search REA安装`；本文是用法真源。
- 运行时：`~/.local/lib/rea/`；项目记录：`~/mycc/2-Projects/rea/`；真实分析样本和结果放对应业务项目，不放上游工具目录。

## 已验证与能力边界

已验证CLI及直接stdio MCP对自有Electron fixture返回非空Evidence，三个JS模块的sha256与本地字节一致，main→logic导入边及IPC invokes/handles配对正确；不存在路径返回invalid_request/ENOENT。Hermes真实Codeg会话242已通过MCP独立完成正反例。Claude/Codex/Grok仅配置及同一启动链核验，Gemini预置配置但本轮PATH内无可执行文件，均不冒称逐客户端模型会话已实测。

doctor中选定客户端/技能healthy=true，但environment_healthy=false：Ghidra/IDA/JADX/Kuna等外部引擎未配置；没有安装Hopper。JS/Electron静态分析不依赖这些引擎。Frida包原生加载通过，不代表已验证动态注入。原生/Android反编译按实际目标准备provider后再验收。静态事实与推断不能写成实际运行行为。

## 更新与回退

仅关注正式Releases：Codeg ID5每周一09:20 Asia/Shanghai轻量检查；固定Hermes周审ID6已停。发现新发行才评估，定时检查不自动升级。

本机采用隔离版本目录。升级时先保留当前目录、launcher和客户端备份，核新发布包integrity与配套技能，再切换固定入口、按明确客户端范围刷新技能并重做真实调用验收。不要盲跑 `rea update` 或滚动 `@latest` 绕过该路径。REA原生setup已在四份原配置旁保留 `.rea.backup`；这些备份可能含原有凭据，禁止打印/放报告/入Git。回退须先核当前配置与并发变化，仅恢复本任务REA条目，不覆盖其他客户端新改动。
