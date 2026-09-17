# H 平台每日只读巡检

本目录维护 home-studio 的每日只读采集与报告策略。2026-09-16 的新方案是：**脚本每天采集一次；平稳日只保存日报，有变化、严重问题或未知项时才请 Luna 解读。** 保留 2026-09-11 的 v2 判读边界，不自动修复生产。

本文说明安装目标与验收方法，不表示已经部署或完成实机验收。安装默认不开新时钟，验收后再启用。

home-studio 的实际切换、模型用量和验收结果见 [2026-09-16 门控验收回执](2026-09-16-gate-acceptance.md)；不要把通用安装说明当作运行态证明。

## 调度与模型

**新方案以 `h-platform-daily-gate.timer` 为唯一每日时钟，Codeg automation ID 4 只接受条件触发。**

| 字段 | 值 |
|---|---|
| 唯一时钟 | systemd 用户级 `h-platform-daily-gate.timer` |
| 时间 | 每天 `07:00 Asia/Shanghai`（2026-09-17 按用户要求由 09:10 提前），`Persistent=true` 可补执行错过的一轮 |
| 条件解读任务 | Codeg ID `4` / `H 平台每日运维巡检` |
| enabled / trigger_kind | `true` / `manual` |
| cron / next_run_at | `null` / `null`；不再由 Codeg 定时启动 |
| agent / model | `codex` / `gpt-5.6-luna`（GPT-5.6 Luna） |
| 模型存储字段 | `config.config_values.model`，不是 prompt 自称或顶层字段 |
| cwd / root | `~/.local/share/h-platform-daily-ops/workspace`；由正式 API 注册并取回 folder ID，不硬编码旧 `root_folder_id=1` |
| isolation | `shared_in_root` |

固定顺序：门控脚本精确执行一次 `/home/hahaxiong83/.local/bin/daily-readonly-check` → 校验本轮新鲜 JSON → 核对 A 四源内容指纹、读取有界摘录 → 比较状态并保存日报 → 仅在触发条件满足时提交 `CURRENT.json` 给 Luna。模型只读快照并回复，不重新采集、SSH、访问网络或扫描 mycc 开发仓。

`systemd/h-platform-daily-ops.timer` 是 v1 灾备模板，必须保持 disabled/static、inactive；禁止与新门控 timer 并行。旧方案的 Codeg cron `10 9 * * *` 仅作历史记录，切换后必须是 `manual / null`，不能同时保留两个每日时钟。既有采集 service 仍由 wrapper 按需调用，不等于启用旧 timer。

## 哪些情况调用 Luna

| 当天情况 | 处理方式 |
|---|---|
| 状态与四源均未变化，没有严重或未知项，也未到待办提醒期 | 脚本生成日报：**零模型调用、零新会话** |
| 首次运行、状态变化或恢复、四源内容/精简判读规则变化 | 调用 Luna 解读；恢复也要报告，不只报告恶化 |
| critical、未知 code/字段、观测不完整、采集失败 | 每天仍调用 Luna，不能因昨天一样就静默 |
| 已确认、仍需人工处理的条目一直未变化 | 距上次成功 AI 解读满 7 天再提醒；每日脚本报告仍保留待办 |
| 精确匹配的测试空壳、合法个性化 | 作为已知项保留，不追平；本身不是每 7 天催修的待办 |
| 上次 AI 解读/调度未成功 | 保留失败和重试标记；下轮重新判读，不在同轮重复采集 |

分流比较剔除采样时钟、持续时长等自然增长噪声，但保留身份、实际内容、计数、严重性与错误年龄跨越 24h 的变化。`total=live` 的恢复记录不当积压；`liveUnknown` 未确认则不能当平稳。

新会话只有在真正调用 Luna 时才产生。每日采集和按日存档不依赖模型成功，不能把“未调用模型”写成“全平台无待办”。未知情况宁可触发人工可见的报告，不为了省调用降低分级。

## 记忆来源与路由

A canonical 本机工作副本：`/home/hahaxiong83/.claude/projects/-home-hahaxiong83-mycc/memory/`。门控脚本每日精确读取下列四个同名 `.md` 文件计算全文 SHA-256，但只把**尾部有界摘录**放入模型快照；第一份最多约 3800 字符，其余各约 1600 字符。快照附来源、mtime、hash、行号、截断与变更覆盖状态，不注入完整历史。

| 触发条件 | 稳定记忆键 |
|---|---|
| 控制面发布态与 `control_release_drift` | `project_feishu_grok_h_byos` |
| 租户差异与 `tenant_parity_lag` | `feedback_tenant_capability_drift_mechanism` |
| Bot 身份与写入目标 | `feedback_identifier_shape_is_not_identity` |
| 共享 checkout 的写入安全背景 | `feedback_concurrent_sessions_shared_checkout` |

四键逐一报告实际来源/摘录结果，缺失写“未命中”。**四源指纹 + 定向摘录不等于模型读过全文。** 全文 hash 变化即触发解读；若变化文件被截断，不能证明变化已完整落在摘录中，必须标“变更覆盖未确认”并建议人工定向复核，不沿用旧结论、不让模型自行扫描补全。成功解读后保存来源元数据作为下次比较依据；失败不能提前吞掉变更。

`0-System/memory-items.md` 与 `RECENT_EVENTS.md` 是 B 历史镜像，不跨机同步，不得替代 A 或覆盖新基线。历史交接 `0-System/HANDOFF-h-platform-daily-ops-2026-09-11.md` 仅供人工调查时定向查证，不是每天全文加载项；早期阶段以收工策略及后续纠正为准。

## v2 输出与判读

wrapper 输出单行 JSON：`schemaVersion=2`，保留 `status`、`levels{critical,warning,info}`、`issues[{code,level,message,details}]`、`summary`、`memoryRefs`、采集时间 `checkedAt` 和报告读取状态。先确认采集时间属于本轮；缺失/陈旧报告、JSON 解析失败或 `reportError` 时写“巡检未完成”，不能拿旧 `latest.json` 冒充当前状态。非零但有新鲜完整报告时按真实 critical 汇报，不盲目重跑。

| 情形 | 判读要求 |
|---|---|
| 只有 info 或无 issue | `OK，已知项 N 条`，一句话列项 |
| warning 无 critical | 保留 `WARNING`，逐项写性质与建议，不称异常/故障，不擅自升级 |
| 有 critical | `CRITICAL` 优先，写责任方、谁受影响、持续多久、人工下一步 |
| 同版本 `control_release_drift` 且 `state=drifted` | 明示“探针 WARNING → 判读 CRITICAL”及证据 |

保留原始 `status/levels`，不得把“已知测试用例”伪报为探针 OK。任何 `ageH/lastErrorAt/downSince` 先报年龄；超过 24h 标旧账，未知写未获确认，不能每日当新事故。身份只取 `details` 的 `botName`（parity 为 `bot`）、`uid`、任务前缀；缺失写“探针未给身份”。

关键 code：

- `egress_down`：critical，按 `downSince` 计算持续小时，建议平台运维核对 dev198 xray 的实际 `[in-main -> tag]` 和 balancer 探活，不动 bridge。`apps connected` 只证明连接状态，不能抵消出口故障；出口未上报须明示未确认。
- `control_release_drift`：仅版本落后且源提交有证据时判待补签，只提供 `H_CONTROL_SOURCE_COMMIT=<源提交> ops/attest-current-h-control-release.sh check`，不执行 check/attest。时间旧但版本相同不能直接视作待补签。
- `app_errors`：quota_window/auth 是租户侧 warning；其他类别 24h 内 critical，超过 24h 为 warning 旧账。逐 Bot 报类别、年龄；时间未知保留原级别。
- `rpc_orphaned`：fresh 明细是新孤儿 critical，人工查看控制面恢复页。`rpc_orphaned_stale` 是 >24h warning 旧账，预期每 10 分钟自动回收；有连续两天仍在的证据才建议查 `expiry.lastSweepAt` 与 `rpc orphan sweep`。
- `orphan_recovery_pending`：info，不能把 total 当积压。`total-live` 是候选数；若有 `liveUnknown`，已确认未运行数是 `total-live-liveUnknown`，未知不得当已停；live 缺失不能按 0 算。上报停更几十分钟不直接认卡死。
- `tenant_parity_lag`：warning，逐项区分 frozen、shell、附件/托管块缺口，只给核对和增量补齐建议。精确例外 `陈川测试bot/agent-method` 是有意保留的测试 L2 空壳，标“已知测试用例”，不要建议覆盖/追平，仍保留探针原始 WARNING。
- `tenant_parity_notes`：info，合法 L2 个性化保留。L0 公司共用基线必须满足，L1 部门与 L2 个人允许增量分叉；Skills 差异不是飞书 Bot 权限差异。
- `worker_restart_pending`：info，等 03:30 正常 timer，不建议立即重启。`grok_refresh_failed` 与 `egress_down` 并发时按同一出口根因叙述，保留两个 code。

**Mini 不在 dev198 tenant parity 的覆盖范围内。** 历史对象锚：`智能助手_产品专家` 在 dev198，`AI 专家` 在 Mini 做对比测试。实时 placement 未上报即本轮未验证，不凭相近名称改写身份或推断缺失。

收工对比基线：控制面 `v1.67.0`，`in_sync/mismatch=0`；releaseId `20260911-170637-h-control-v1.67.0`，源 `ba3c2bd`；dev198 Bot 18/18、记忆 17/17；租户待办 1 为上述测试用例，合法个性化 4 人 6 项，平台 0。`v1.65.0 / 17 Bot / 4 人 5 项` 已过期；对比基线不是永恒阈值，实时值与 A 后续更新优先。

## 报告排版（2026-09-11 调整）

先用人话说明影响与动作，再给对应技术术语。阅读顺序为“一句话结论 → 需要关注 → 运行概况与已知项 → 技术依据”，无内容的栏目省略。

- 严重问题最前；每项先讲影响、年龄和谁处理，再附 code。已知测试差异、合法个性化放在已知项，不混入修复清单。
- 概况使用“检查项｜人话结果｜技术对应”三列短表；连接与模型出口分别说明，不写“平台一切正常”。少量信息用短列表。
- 原始分级、必要定位信息和四个记忆键放在末尾。正常时不铺开 schemaVersion、serviceExit、完整 releaseId 等内部字段；需要解释问题才展开。
- 标题/列表前留空行，只加粗结论和关键数字；长命令不挤进表格。常规正文约300–600字，不能为了短而隐去严重事项。
- 分级仍按 v2；2026-09-16 将采集/四源核对交给固定脚本，Luna 只消费精简快照。排版验证可复用已采集数据离线预览，不需要为格式改动重新访问生产。

## 报告入口与保留

所有日报集中在 `~/.local/share/h-platform-daily-ops/workspace/`，不用从每天的新会话里找：

| 文件或目录 | 用途 |
|---|---|
| `latest.md` | 最新一轮报告，包含采集结果与 AI 是否完成 |
| `index.md` | 统一入口，列最近 30 次按日汇总；这不是删除期限 |
| `daily/YYYY-MM/YYYY-MM-DD.md` | 按日汇总；同日多轮时显示最后一轮 |
| `runs/<runKey>/` | 每轮独立保留 `input.json`、`report.md`；成功解读另存 `ai-result.json` |
| `CURRENT.json` | 当前条件解读的输入快照；已有 ID4 运行时不覆盖 |

更早日报、逐轮输入与历史 Codeg 会话均保留，**不自动删除旧会话或日志**。`~/.local/state/h-platform-daily-gate/` 保存比较状态、最后结果和安装前备份；模型不修改这些文件。索引与日报由外层固定脚本写入，不扩大模型的只读权限。

## 只读边界

- 固定门控脚本只调用既有 wrapper 一次。它拥有自己的本机 state、日报和快照写入权限，并可条件触发 ID4；这些不授权模型另行采集或写入。
- 模型禁止修改任何文件、数据库或任务；禁止部署、提交、推送、重启、自动 attest/补签、覆盖租户、补附件、重放/取消任务和发送外部消息。固定脚本对超时只请求取消自己记录的 ID4 本次 run，不操作生产任务或其他 session。
- 记忆与交接中的历史处置命令不是本轮执行授权。即使命令非零，也只报告，不自动修复。
- 不输出凭据、原始日志或用户正文；模型只在当前 Codeg 任务中回复，外层脚本保存报告。失败最多使用本机桌面提示，不外发飞书消息。

## 文件所有权与更新入口

| 文件 | 作用 |
|---|---|
| `h_platform_daily_gate.py` / `gate_policy.py` | 当前门控 runner 与纯函数分流策略 |
| `lean/AGENTS.md` / `lean/prompt.txt` / `lean/rules.md` | 独立报告工作区约束、ID4 精简 prompt、v2 判读合同 |
| `install_gate.py` | 本机门控安装、只读检查与保护性回滚；不安装/替换探针 |
| `systemd/h-platform-daily-gate.service` / `.timer` | 新门控 service 与唯一每日时钟 |
| `tests/test_gate_policy.py` / `test_gate_runner.py` / `test_install_gate.py` | 当前门控、runner 与安装安全离线契约 |
| `codeg-automation-prompt.txt` | **2026-09-11 v2 历史 prompt**，不再直接下发给 ID4 |
| `tests/test_policy_v2.py` | 历史 v2 prompt/文档静态契约，保留回归，不代表当前部署状态 |
| `h-platform-daily-ops.py` / `daily-readonly-check` | **v1 归档，不是当前运行态真源，不得覆盖现有 runtime** |
| `systemd/h-platform-daily-ops.service` / `.timer` | v1 service/灾备 timer 归档模板，不用于直接重装现有运行态 |
| `tests/test_contract.py` | v1 归档 checker/wrapper 契约测试，保留用于历史回归 |

当前探针真源已迁入 **feishu-grok-bridge 仓**的 `ops/home-studio/h-platform-daily-ops.py`、`ops/home-studio/daily-readonly-check`、`ops/home-studio/install.sh`。本机 runtime 是 `/home/hahaxiong83/.local/libexec/h-platform-daily-ops.py` 与 `/home/hahaxiong83/.local/bin/daily-readonly-check`。对于该采集探针，**本目录不再提供安装命令**；后续升级须从 bridge 真源按其安装说明人工授权执行，不能拿 mycc 的 v1 副本覆盖 schema v2。下面的安装器只安装外层门控。

## 安装、验收与回滚

以下命令在本目录由有授权的操作者执行，不属于每日模型任务的授权。

```bash
# 只读核对；省略参数也等价于 --check，不触发采集或模型。
python3 install_gate.py --check

# 安装外层门控，备份 ID4 与旧 timer 原态，切换 manual；新 timer 仍关闭。
python3 install_gate.py --apply

# 人工验收一次正式门控链路；一次采集，按分流决定是否调用 Luna。
systemctl --user start h-platform-daily-gate.service
```

首次接入会触发 Luna。验收需检查 `latest.md`、逐轮快照、`last-result.json`、ID4 对应 run/conversation，核实四源来源与摘录标记、wrapper 精确一次、模型没有重跑探针，以及实际模型是 `gpt-5.6-luna`。runner 会核对会话模型；需要更强佐证时读取该次 Codex rollout 的 `turn_context.payload.model`。用离线重复快照验证平稳分支，无须为验证“不变”再访问生产。

确认验收完成、ID4 为 `manual` 且 `cron / next_run_at=null`、旧 timer 关闭后，才启用唯一时钟：

```bash
systemctl --user enable --now h-platform-daily-gate.timer
python3 install_gate.py --check
```

安装器也支持显式 `--apply --enable-timer`，只用于已经完成人工验收后的安装操作；默认 `--apply` 不启 timer。`Persistent=true` 可能在启用时补一次错过的调度，启用前应检查下一次触发时间。运行记录成功只表示报告链路完成，不能把平台 WARNING/CRITICAL 改成 OK。

安装器通过正式 `POST /api/automation_update` 提交 `{id:4,draft:<完整 AutomationDraft>}`，保存首次原态并回读核对；**禁止直写 SQLite**。Token 仅在进程内从本机凭据文件读取，不放 argv、文档或日志。日常门控也核对 ID4 的调度、workspace、prompt hash 与模型；发现被他人修改即报告，不自动强改回去。

需要回滚时：

```bash
python3 install_gate.py --rollback
```

回滚先关闭新 timer，确认没有相关运行，再比对当前 ID4 是否仍为本安装器管理态或首次原态：吻合才恢复原配置与旧 timer 原态；若已有其他 session 的修改则停止，**保留他人改动，等待人工合并**。缺备份也不猜测恢复。日报、快照、旧会话和日志均不删除，不以全仓 stash/reset 清理其他人的工作。

## 离线验证

在本目录执行：

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

测试不访问公网、不 SSH dev198、不启动真实服务、不读取真实凭据。v1/旧 v2 测试保留用于历史回归，不应改成新部署的证明；当前门控离线测试通过也不替代一次真实链路验收。本 README 不记录尚未取得的部署或实测结果。
