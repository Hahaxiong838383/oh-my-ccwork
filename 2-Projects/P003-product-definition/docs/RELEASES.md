# P003 小可 · 生产版本总表（RELEASES）

> 维护规则：每个「正式版」= 一组可回滚的组合（APK + Server + Worker + 开关）。标签打在 server 提交上，组合里的其它锚写进标签 message 与本表；改组合就加一行，不改旧行。

| 版本 | 状态 | 标签 → server 提交 | One-shot | 组合锚 | 回滚 |
|---|---|---|---|---|---|
| **V1.0 正式版** | 2026-09-13T07:06Z 前的生产现役 | `p003-v1.0-no-oneshot` → `f011ace1a` | **无**（仅研发灰度一台走名单） | APK OTA 现役 **v263 = 1.2.2-canary.251**（sha256 `5d164461360f…`，全量 rollout）；Server `f011ace1a`（`device-session.ts` md5 `eafe9820…`，策略键未设 = allowlist）；Worker 生产 `voice-worker-rust` exe `f3707e7e…`（commit `3a2af41c3`） | — |
| **V1.1 正式版** | **服务端已上线 2026-09-13T07:06:25Z**；One-shot Worker 池容量升级脚本已就绪待执行；APK 待 codex 发布 | `p003-v1.1-oneshot` → `add34a8db` | **有**：OTA 到 V1.1 APK 的设备自动具备（能力协商，零人工名单） | Server `add34a8db`（`device-session.ts` md5 `504dd062…`）+ `.env.local` `ONESHOT_FIRST_TURN_POLICY=capability`、`ONESHOT_FIRST_TURN_AGENT_NAME=rust-worker-firstturn`；Worker One-shot 池 `voice-worker-firstturn` exe `c2b84b2e…`（commit `299b074`，含 B68/B69 控制出口修复），目标 `WORKER_MAX_JOBS=10` / `MemoryHigh 1200M` / `Max 1500M`；APK：versionCode > 270 且含启动迁移（codex），v270 = 声学/交互基线不含自动启用 | **开关**：`.env.local` `ONESHOT_FIRST_TURN_POLICY=off`（全停）或 `allowlist`（只名单）+ `pm2 restart p003-voice`；已签票据 ≤1h 自然过期，不切断会话。**文件级**：`/opt/p003/_backup/20260913-070625-b84-policy/`。**Worker**：`/root/rust-worker-firstturn/voice-rust-worker.rollback-71e42ab0-20260912T083440Z` |

## 服务端开关（`ONESHOT_FIRST_TURN_POLICY`）

| 值 | 行为 | 用途 |
|---|---|---|
| `capability`（V1.1 生产值） | 已准入设备 ∧ 请求 `supports` 同时含 `oneshot_first_turn_v1`、`local_receipt_v1` ∧ 已配派单目标 → 签首句合同、派 `rust-worker-firstturn`；否则普通语音 | 产品态：OTA 即用 |
| `allowlist`（默认/未设） | 只对 `ONESHOT_FIRST_TURN_SN_ALLOW` 名单内 ∧ 声明 `oneshot_first_turn_v1` 的请求签 | 研发灰度 / 半回滚 |
| `off` | 一台都不签 | 全局暂停 / 回滚 |
| 其它值 | 按 `allowlist` 处理并 `console.warn` | 配置错保护 |

每次签发日志带 `policy=<值> supports=<能力名|…或 ->`，老/新客户端各走哪条路径可从 `[device-session] ok` 行对账。

## 验收状态

- 服务端：单测 37/37（含 B84 9 条 + 3 处负向注入各红 2 条）；生产 `/health` ok、无凭据探针 401、error 日志零告警（2026-09-13T07:09Z）。
- 设备侧：等 B78 §4 A/B 两轮（codex 组织）；V1.1 APK 的启动迁移由 codex 实现与发布。
- 变更记录：B84（codex 需求）→ B85（cc 回执）。
