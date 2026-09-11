# H 平台每日只读巡检

本目录维护 home-studio 的 Codeg 每日巡检判读策略。2026-09-11 按 cc 收工回执升级至 v2，自 2026-09-12 起每日执行；只解释采集证据，不自动修复生产。

## 调度与模型

**Codeg automation ID 4 是唯一每日调度源。**

| 字段 | 值 |
|---|---|
| ID / 名称 | `4` / `H 平台每日运维巡检` |
| enabled | `true` |
| cron / timezone | `10 9 * * *` / `Asia/Shanghai` |
| agent / model | `codex` / `gpt-5.6-luna`（GPT-5.6 Luna） |
| 模型存储字段 | `config.config_values.model`，不是 prompt 自称或顶层字段 |
| cwd / root | `/home/hahaxiong83/mycc` / `root_folder_id=1` |
| isolation | `shared_in_root` |

固定顺序：定向读取 A 四键 → 精确执行一次 `/home/hahaxiong83/.local/bin/daily-readonly-check` → 校验本次新鲜 JSON → 按 v2 判读 → 只在 Codeg 任务内汇报。不能另跑 checker、手动 SSH 或重复运行“等绿灯”。

`systemd/h-platform-daily-ops.timer` 是 v1 灾备模板，必须保持 disabled/static、inactive；禁止与 Codeg ID 4 同时启用。只有明确停用 Codeg 后才能另行审批灾备调度，不创建第二条每日任务。

## 记忆来源与路由

A canonical 本机工作副本：`/home/hahaxiong83/.claude/projects/-home-hahaxiong83-mycc/memory/`。巡检先精确读取下列四个同名 `.md` 文件，长文件按日期/标题/code 定向读取命中段及后续纠正，最新证据优先。

| 触发条件 | 稳定记忆键 |
|---|---|
| 控制面发布态与 `control_release_drift` | `project_feishu_grok_h_byos` |
| 租户差异与 `tenant_parity_lag` | `feedback_tenant_capability_drift_mechanism` |
| Bot 身份与写入目标 | `feedback_identifier_shape_is_not_identity` |
| 共享 checkout 的写入安全背景 | `feedback_concurrent_sessions_shared_checkout` |

四键逐一报告实际召回结果，缺失写“未命中”，不脑补、不全仓扫描。`0-System/memory-items.md` 与 `RECENT_EVENTS.md` 是 B 历史镜像，不跨机同步，不得替代 A 或覆盖新基线。需要过程证据时才定向读取 `0-System/HANDOFF-h-platform-daily-ops-2026-09-11.md`；早期阶段以收工策略及后续纠正为准。

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
- 分级仍按 v2，模型、调度、四键召回和单次采集不变。排版验证可复用已采集数据离线预览，不需要为格式改动重新访问生产。

## 只读边界

- 只调用既有 wrapper；它内部的只读采集、本机巡检 state/临时文件与桌面提示属于既有链路，不授权 agent 另行写入。
- 禁止修改任何文件、数据库或任务；禁止部署、提交、推送、重启、自动 attest/补签、覆盖租户、补附件、重放/取消任务和发送外部消息。
- 记忆与交接中的历史处置命令不是本轮执行授权。即使命令非零，也只报告，不自动修复。
- 不输出凭据、原始日志或用户正文；只在当前 Codeg 任务中报告。

## 文件所有权与更新入口

| 文件 | 作用 |
|---|---|
| `codeg-automation-prompt.txt` | v2 策略版本化副本，对应 Codeg ID 4 prompt |
| `tests/test_policy_v2.py` | v2 prompt/文档静态契约，不联网、不运行真实探针 |
| `h-platform-daily-ops.py` / `daily-readonly-check` | **v1 归档，不是当前运行态真源，不得覆盖现有 runtime** |
| `systemd/` | v1 service/灾备 timer 归档模板，不用于直接重装现有运行态 |
| `tests/test_contract.py` | v1 归档 checker/wrapper 契约测试，保留用于历史回归 |

当前探针真源已迁入 **feishu-grok-bridge 仓**的 `ops/home-studio/h-platform-daily-ops.py`、`ops/home-studio/daily-readonly-check`、`ops/home-studio/install.sh`。本机 runtime 是 `/home/hahaxiong83/.local/libexec/h-platform-daily-ops.py` 与 `/home/hahaxiong83/.local/bin/daily-readonly-check`。本目录不再提供安装命令；后续安装或升级须从 bridge 真源按其安装说明人工授权执行，不能拿 mycc 的 v1 副本覆盖 schema v2。

仅更新判读策略与模型时，通过正式 `POST /api/automation_update` 提交 `{id:4,draft:<完整 AutomationDraft>}`；先读取/保存当前配置，保留无关字段，只改 prompt 和 `config.config_values.model`。禁止直写 SQLite。Token 只在进程内从本机凭据文件读取，不放 argv、文档或日志。

更新后以 `POST /api/automation_get {"id":4}` 回读调度、agent、root、isolation 和模型。首次接入、更换模型或采集链时，人工触发一次 `automation_run_now`，通过 `automation_runs` 对应的 conversation 及 Codex rollout `turn_context.payload.model` 核实实际为 `gpt-5.6-luna`，并确认四键召回、探针一次和判读结果；纯排版调整可复用快照做离线样稿验收，不重复采集。运行记录成功只表示任务完成，不能把平台 WARNING/CRITICAL 改成 OK。

## 离线验证

在本目录执行：

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

测试不访问公网、不 SSH dev198、不启动服务、不读取真实凭据。v1 测试通过不代表当前 v2 runtime 通过；v2 静态契约通过也不替代一次真实自动化验收。
