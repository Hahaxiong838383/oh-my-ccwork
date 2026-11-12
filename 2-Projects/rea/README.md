# REA 持续跟踪与接入评估

> 创建：2026-10-21。状态：REA 6.7.0 已安装，CLI与Hermes原生MCP调用已验；只跟踪正式Releases。

用户要求 Codex 与 Hermes 持续跟进 https://github.com/morluto/rea，保持信息和接入建议更新。本目录保存项目管理资料、公开上游证据和评估结论；上游源码、node_modules、dist、目标样本不进入本目录。

本机使用入口见 [usage.md](usage.md)，安装真值见 [installation.json](installation.json)。历史调查中的“未安装”仅对应当时状态。

## 文件与写入规则

- `2026-10-21-source-assessment.md`：首次源码/环境评估，历史快照，不覆盖。
- `tracking-policy.md`：跟踪范围、分工、更新判据及验收要求。
- `baseline.json`：首次实测基线，历史快照，不覆盖。
- `latest.json`：首次完整核验快照，保留其原始检查时间；不再每日刷新。
- `release-state.json`：当前正式 Release 的身份、检查时间和状态。
- `weekly-review.md`：Hermes 首轮独立复核，历史观点；最终采纳意见见 `reports/2026-10-21-decision.md`。
- `automation.json`：Codeg 调度接线的任务 ID、时间与验证记录，无凭据。
- `reports/`：正式 Release 变化评估、决策记录及首轮历史报告；写入前先读其 README。

写本目录前先读本文件。批量更新用本目录 `.tracking.lock` 的 flock 锁；先读后写、原子替换，避免覆盖并发结果。原始公开数据按需放 reports，禁止凭据、个人配置全文或他人数据。

## 当前判断

REA 作为机器级 CLI/MCP 工具与配套用户级技能接入。mycc 管版本、配置指针和验收；MyAgent 的具体项目保存相应分析成果。普通使用不需要长期 clone REA 开发树，不新建 HOME 顶层 rea 目录。

当前运行：REA 包仍为 6.7.0，使用专用Node24.22.0，入口~/.local/bin/rea（默认PATH Node已是24.22.3，未改动）。**2026-11-12 起技能改为源码 main 导出**：`reverse-engineer-anything` v62（8 个 reference，来源 main `a016743`，仅把 `@latest` 钉成 `@6.7.0`），并新增本地运维技能 `rea`（安装真值/接入/207 工具目录/排障/升级）。因此 `rea doctor` 的 skill.state 会报 `stale`（包期望 42）——预期状态，不要为此跑 `rea setup`（会降回 42 并重写客户端配置）。详见 [reports/2026-11-12-skill-update.md](reports/2026-11-12-skill-update.md)。升级到 6.8.0 仍有硬前提：需 Node ≥24.22.1。**2026-11-12 已把 REA 注册进 DSH**：`~/dsh-stack/home/cordis.patch.yml` 的 `rea-mcp` 条目（doctor aligned，主 Web 实例 HMR 已挂载，一次性验收 207 工具 + 真实 JS 分析通过）。注意 `rea setup` 会把技能降回包内 v42（已实测并从快照还原），详见 [reports/2026-11-12-skill-update.md](reports/2026-11-12-skill-update.md)。

## 持续执行

2026-10-21 按用户最新要求缩为正式 Releases 跟踪：Codeg ID 5 每周一 09:20 Asia/Shanghai 轻量检查；无变化只更新时间，有正式发布变化再评估。每日检查已取消，ID 6 固定 Hermes 周审已停用；Hermes 在需要采用评估时按需复核。准确任务状态见 automation.json 与 Codeg 运行记录。

结果在 Codeg 自动化运行会话以及本目录查看。任务依赖 home-studio 与 codeg-server 运行；未来自然触发是否成功以运行记录和新产物为准。
