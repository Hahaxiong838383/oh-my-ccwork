# H 平台每日只读巡检

home-studio 上 H 平台 / feishu-grok-bridge 的每日运维巡检资产。它只采集控制面与 dev198 的只读状态，输出匿名 JSON，再由 Codeg 结合项目记忆解释漂移；不自动修复生产。

## 调度真值

**Codeg automation ID 4 是唯一每日调度源。** 当前正式配置：

| 字段 | 值 |
|---|---|
| ID / 名称 | `4` / `H 平台每日运维巡检` |
| enabled | `true` |
| cron / timezone | `10 9 * * *` / `Asia/Shanghai` |
| agent | `codex` |
| root / isolation | `root_folder_id=1` / `shared_in_root` |

调用链：

```text
Codeg ID 4（09:10）
  → daily-readonly-check
  → h-platform-daily-ops.service（oneshot）
  → h-platform-daily-ops.py
  → ai.kidshub.cn healthz + dev198 只读探针
  → latest.json
  → 单行匿名 JSON（issues + memoryRefs）
  → Codeg 定向召回项目记忆并解释
```

`systemd/h-platform-daily-ops.timer` 仅是灾备时钟模板，**必须保持 disabled/static**。它有意不含 `[Install]`，禁止与 Codeg ID 4 同时启用，否则每天会双跑。部署后应验证：

```bash
systemctl --user disable --now h-platform-daily-ops.timer
systemctl --user is-enabled h-platform-daily-ops.timer  # 期望 disabled 或 static
systemctl --user is-active h-platform-daily-ops.timer   # 期望 inactive
```

只有在明确停用 Codeg ID 4 后，才可单独审批灾备 timer 的启用；不能把 timer 当第二条“更稳”的并行调度链。

## 只读边界

- checker 只读公网控制面 healthz、dev198 服务/定时器状态、bridge healthz、租户 parity、记忆健康、磁盘与错误计数。
- 远端 `.env` 只用于让既有审计脚本正常读取配置；凭据不进入 stdout、报告或 Git。
- wrapper 只启动 oneshot service、读取 `latest.json`，并输出 `code/level/message`、摘要与稳定记忆键。
- Codeg 只能汇报：禁止修改文件/数据库/任务，禁止部署、提交、推送、重启、补签、覆盖租户或发送外部消息。
- 命令非零、记忆未命中或问题无法归类时，保持原状并明确报告，禁止脑补或顺手修复。

## Issue code → 记忆键

| 触发条件 | 首要记忆键 | 用途 |
|---|---|---|
| `control_release_drift` | `project_feishu_grok_h_byos` | 判断控制面漂移、发布补签历史与生产真值 |
| `tenant_parity_lag` | `feedback_tenant_capability_drift_mechanism` | 区分合法增量、同名遮蔽与附件缺口 |
| 涉及 Bot 身份或写入目标 | `feedback_identifier_shape_is_not_identity` | 用 `appId + 精确 botName + executionSite` 与内容 SHA 锚定对象 |
| 涉及共享 checkout 写入安全 | `feedback_concurrent_sessions_shared_checkout` | 只在明确授权写入时采用隔离/stash 规程；本巡检自身不写 |

Prompt 会先在 `0-System/memory-items.md` 与 `RECENT_EVENTS.md` 定向查这四个稳定键，只读取命中段。任一键未命中必须明报，不能扩大成全仓扫描。

控制面发布态 `state=in_sync` 且 `mismatchCount=0` 是健康终态，不得生成 `control_release_drift`；只有状态不属于 `{空值, trusted, in_sync}`，或者差异数非零时才告警。该条件有独立回归测试。

## 租户差异判读

平台版只约束 L0 公司共用基线；L1 部门版、L2 个人版允许在上层基线之上增量分叉。`tenant_parity_lag` 是需要解释的 warning，不自动等于故障，更不是飞书 Bot 权限差异。

必须区分：

1. 合法 L2 个人增量：信息项，保留。
2. 同名 L2 遮蔽：人工判断是否有意覆盖。
3. `references/` 缺失：真实能力缺口；正文一致时只补附件，不覆盖正文。
4. 平台基线缺失：检查 L0 发布链，不拿个人版反向覆盖平台。

**Mini 不在 dev198 tenant parity 的覆盖范围内。** 仅部署在 Mini 的 Bot/租户不能因为 dev198 没有对应项而被报成缺失。当前对象锚：`智能助手_产品专家` 在 dev198，应与平台版一致；`AI 专家` 在 Mini，是对比测试 Bot，允许保留差异。名字相近不构成身份。

## 文件

| 文件 | 作用 |
|---|---|
| `h-platform-daily-ops.py` | 当前 home-studio checker 的版本化副本 |
| `daily-readonly-check` | Codeg 唯一执行入口；输出单行 JSON |
| `codeg-automation-prompt.txt` | Codeg automation ID 4 当前 Prompt |
| `systemd/h-platform-daily-ops.service` | oneshot service 模板 |
| `systemd/h-platform-daily-ops.timer` | 默认禁用、不可 enable 的灾备模板 |
| `tests/test_contract.py` | wrapper 输出、issue 路由、只读与防双跑契约测试 |

## 安装与更新

本目录是版本化真源，但不会自动改本机运行态。更新运行态前先对撞 diff，并保留用户级路径与权限：

```bash
install -m 0755 h-platform-daily-ops.py "$HOME/.local/libexec/h-platform-daily-ops.py"
install -m 0755 daily-readonly-check "$HOME/.local/bin/daily-readonly-check"
install -m 0644 systemd/h-platform-daily-ops.service "$HOME/.config/systemd/user/h-platform-daily-ops.service"
install -m 0644 systemd/h-platform-daily-ops.timer "$HOME/.config/systemd/user/h-platform-daily-ops.timer"
systemctl --user daemon-reload
systemctl --user disable --now h-platform-daily-ops.timer
```

Codeg Prompt 更新必须通过正式 API `POST /api/automation_update`，提交完整 `AutomationDraft`，不能只发局部 prompt；更新后用 `POST /api/automation_get`（`{"id":4}`）回读 enabled、cron、timezone、agent、root 与 isolation。Token 只从本机凭据文件注入，禁止写进命令、文档或日志。

## 输出契约

wrapper 正常时只打印一行 JSON：

```json
{"schemaVersion":1,"ok":true,"serviceExit":0,"status":"WARNING","issueCount":2,"issues":[{"code":"control_release_drift","level":"warning","message":"..."}],"memoryRefs":["project_feishu_grok_h_byos","feedback_tenant_capability_drift_mechanism","feedback_identifier_shape_is_not_identity","feedback_concurrent_sessions_shared_checkout"],"summary":{},"report":".../latest.json"}
```

`issues` 只保留 `code/level/message`；`memoryRefs` 是稳定键，不放记忆正文。报告读取失败时退出 `3`，仍输出四个记忆键；checker 的 `CRITICAL/WARNING/OK` 退出语义保持不变。

## 离线验证

```bash
python3 -m py_compile h-platform-daily-ops.py
bash -n daily-readonly-check
python3 -m unittest -v tests/test_contract.py
systemd-analyze --user verify systemd/h-platform-daily-ops.service systemd/h-platform-daily-ops.timer
```

测试不访问公网、不 SSH dev198、不启动服务、不读取真实凭据。
