# P003 小可 · 生产版本总表（RELEASES）

> 维护规则：每个「正式版」= 一组可回滚的组合（APK + Server + Worker + 开关）。标签打在 server 提交上，组合里的其它锚写进标签 message 与本表；改组合就加一行，不改旧行。

| 版本 | 状态 | 标签 → server 提交 | One-shot | 组合锚 | 回滚 |
|---|---|---|---|---|---|
| **V1.0 正式版** | 2026-09-13T07:06Z 前的生产现役 | `p003-v1.0-no-oneshot` → `f011ace1a` | **无**（仅研发灰度一台走名单） | APK OTA 现役 **v263 = 1.2.2-canary.251**（sha256 `5d164461360f…`，全量 rollout）；Server `f011ace1a`（`device-session.ts` md5 `eafe9820…`，策略键未设 = allowlist）；Worker 生产 `voice-worker-rust` exe `f3707e7e…`（commit `3a2af41c3`） | — |
| **V1.1 正式版** | **服务端已上线 2026-09-13T07:06:25Z**；One-shot Worker 池已升生产规格（08:09:35Z，PID 2902239，10 路/1200M-1500M）；**APK v271 原包已由 codex 交合包（尚未 OTA 发布）** | `p003-v1.1-oneshot` → `add34a8db` | **有**：OTA 到 V1.1 APK 的设备自动具备（能力协商，零人工名单） | Server `add34a8db`（`device-session.ts` md5 `504dd062…`）+ `.env.local` `ONESHOT_FIRST_TURN_POLICY=capability`、`ONESHOT_FIRST_TURN_AGENT_NAME=rust-worker-firstturn`；Worker One-shot 池 `voice-worker-firstturn` exe `c2b84b2e…`（commit `299b074`，含 B68/B69 控制出口修复），目标 `WORKER_MAX_JOBS=10` / `MemoryHigh 1200M` / `Max 1500M`；APK：**v271 = 1.2.2-canary.259（versionCode 271，85,596,381 B，sha256 `c1a79b30…`）含启动一次性迁移**（codex 交付；企业分支 `kidshub-ai-oneshot`，tag `p003-oneshot-v271-ota-auto-enable-20260913`；待同事合入业务主线、递增版号后 OTA）；v270 = 声学/交互基线不含自动启用 | **开关（止扩）**：`.env.local` `ONESHOT_FIRST_TURN_POLICY=off`（全停）或 `allowlist`（只名单）+ `pm2 restart p003-voice`；已签票据 ≤1h 自然过期、进行中会话不断。⚠️ **对已开首句工厂的新端（v271+）这不是「回普通」——它下一次唤醒会 `first_turn_not_granted` 失败**（B87 §3 端侧源码边界）；要让新端继续普通语音须端侧合法停用首句工厂（维护配置/回退 APK）。见下「回滚顺序」。**文件级**：`/opt/p003/_backup/20260913-070625-b84-policy/`。**Worker**：`/root/rust-worker-firstturn/voice-rust-worker.rollback-71e42ab0-20260912T083440Z` |

## 服务端开关（`ONESHOT_FIRST_TURN_POLICY`）

| 值 | 行为 | 用途 |
|---|---|---|
| `capability`（V1.1 生产值） | 已准入设备 ∧ 请求 `supports` 同时含 `oneshot_first_turn_v1`、`local_receipt_v1` ∧ 已配派单目标 → 签首句合同、派 `rust-worker-firstturn`；否则普通语音 | 产品态：OTA 即用 |
| `allowlist`（默认/未设） | 只对 `ONESHOT_FIRST_TURN_SN_ALLOW` 名单内 ∧ 声明 `oneshot_first_turn_v1` 的请求签 | 研发灰度 / 半回滚 |
| `off` | 一台都不签。老端（无 supports）照常普通语音；**已开首句工厂的新端唤醒失败**（端侧强制合同，不回退普通票据） | 止扩；配合端侧停用才是完整回滚 |
| 其它值 | 按 `allowlist` 处理并 `console.warn` | 配置错保护 |

每次签发日志带 `policy=<值> supports=<能力名|…或 ->`，老/新客户端各走哪条路径可从 `[device-session] ok` 行对账。

## 回滚顺序（B87 §3 端侧边界，2026-09-13）

1. **止扩**：服务端 `ONESHOT_FIRST_TURN_POLICY=off`（或 `allowlist`）+ `pm2 restart`——新签发立刻停；老端不受影响；进行中会话不断。
2. **新端恢复普通语音**：需端侧合法停用首句工厂（维护配置）或回退到不含迁移的 APK——**只关服务端不够**，v271+ 唤醒会 `first_turn_not_granted` 失败而不是退回普通票据（`VoiceRustWorkerClient.wake` 在工厂已启动时强制合同 V1；`contract:null` 走 `wake_connect` 失败并停止）。
3. **Worker 回滚**：等已签票据排空（TTL ≤1h）与活跃房结束后再动 `voice-worker-firstturn`；**不能把 ordered 首句房派到不支持 ordered 的旧 `rust-worker`**。
4. 不删端侧迁移 marker，不清 Keystore/凭据。

## 验收状态

- 服务端：单测 37/37（含 B84 9 条 + 3 处负向注入各红 2 条）；生产 `/health` ok、无凭据探针 401、error 日志零告警（2026-09-13T07:09Z）。
- 设备侧：v271 启动自检四项通过（旧 0 升级 / 缺失自启 / 重复幂等 / 关 0 保持，codex B87）；**真实 OTA 安装上报链 + 名单外设备一句传统唤醒、一句连说、退出**仍待（最小发布验证）。
- 真流量签发样本（新端 first_turn_v1 / 老端普通）：截至 2026-09-13T08:37Z 仍 0 条（无唤醒流量，非故障）。
- 变更记录：B84（codex 需求）→ B85/B86（cc 回执）→ B87（codex v271 交付 + 回滚边界）→ B88（cc 文档收口）。
