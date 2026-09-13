# B90｜端侧需求：服务端拒签首句合同时，新端要优雅回落普通语音——否则后台 `off` 对已升级设备是失声，不是回滚

**给 codex 的需求文档**（川哥拍板，2026-09-13 17:18 CST）。川哥的目标 2 是「保留服务端回退开关，便于出问题回滚」。按你 B87 §3 核出的端侧边界，这个开关今天只对**未升级**设备是回滚；对升到 v271 的设备，`off` 会让每一次唤醒在 `first_turn_not_granted` 处断掉——**全量 OTA 之后服务端单方面 `off` = 全部设备失声**。这不是川哥要的回滚。服务端管不了「坚持要合同的客户端拿不到之后怎么办」，所以这条需求在端侧。

## 1. 现状（你 B87 §3 的源码事实，我转述）

1. 迁移开启首句工厂后，`VoiceRustWorkerClient.wake` 在工厂已启动时**强制合同 V1**。
2. 服务端回 `contract:null` → `first_turn_not_granted` → `wake_connect` 失败并停止；**同一次唤醒不重试普通票据**。
3. 只有「工厂未就绪、请求前返回 null」才走普通路径——那是端侧自判，与「服务端拒绝」是两条不同分支。

服务端这侧（B84/B89）：`contract:null` 的语义与 B23 以来完全一致——响应 `contract:null`、`expected_agent_name=rust-worker`、JWT metadata 不含三键；这张票据本身就是一张**合法的普通语音票据**，老 worker 能接。换句话说，新端拿到的不是「错误」，是「一张可用的普通票」，只是它现在不用。

## 2. 需求

**服务端回 `contract:null`（或 `expected_agent_name` ≠ 首句 agent）时，新端把这次唤醒按普通语音完成，不失败、不挂起、不静默丢话。** 具体：

| # | 要求 | 说明 |
|---|---|---|
| R1 | 同一次唤醒内回落 | 收到 `contract:null` 就用**这张票**走普通 RTC 路径（不需要再请求一张；票据本身合法）。若端侧实现上必须重新请求，则不带 `supports` 再要一张，仍在本次唤醒内完成 |
| R2 | 已按 ordered 采集的那句指令 | 你定：要么把已采音频改走普通 RTC 上行（等价于用户唤醒后说了这句），要么丢弃并**本地明确提示**「请再说一遍」。**不允许**静默丢弃或投给不认 ordered 的旧 worker |
| R3 | 后续唤醒不锁死 | 不因一次拒签就把工厂关掉或写 marker；服务端恢复 `capability` 后下一次唤醒自动回到 One-shot。也不需要端侧记住服务端状态——每次唤醒以本次响应为准 |
| R4 | 不放宽校验 | 合同存在时的 metadata/agent 校验一行不改（错合同仍失败，不「兼容」）；只有**明确的 `null`** 才回落。B29 fail-closed 语义在端侧也保持 |
| R5 | 可观测 | 回落时端侧打一条事件（建议 `first_turn_fallback_normal reason=contract_null trace=…`），与服务端日志 `contract=- policy=<off|allowlist> policy_src=…` 可按 trace 对齐 |

不改：传统唤醒路径、STOP/EXIT、音量/AEC/阈值、迁移 marker、Keystore/凭据、Session API wire（不加字段）。

## 3. 验收矩阵（我配合，后台开关秒生效可随时切）

| 场景 | 服务端 | 预期 |
|---|---|---|
| A 正常 | 后台 `capability` | v271 唤醒+连说 → One-shot（`contract=first_turn_v1`，agent firstturn）——现状不回退 |
| B 止扩后唤醒 | 后台 `off` | v271 唤醒 → **普通语音可用**：传统「小可小可」→ 等本地回应 → 问一句 → 正常回答；服务端日志 `contract=- policy=off policy_src=override`，端侧有 R5 事件 |
| C 止扩后连说 | 后台 `off` | v271 唤醒+连说 → 按 R2 二选一，**不失败不挂起**；不得出现 `first_turn_not_granted` 停机 |
| D 恢复 | 后台切回 `capability` | 不装包、不重启 Launcher，下一次唤醒自动回 One-shot（R3） |
| E 老端不变 | 任意 | 老 APK 全程普通语音，零影响（回归锚） |

B/C 各来一次即可，不上矩阵。测试窗口你定；开关我这边点，或者你用 admin 账号自己点（后台 Worker 区「🧩 版本与 One-shot」）。

## 4. 完成前的过渡纪律

- 在 R1–R3 落地前，**后台 `off`/`allowlist` 只当止扩用**，别在有 v271 设备的情况下当回滚点；后台确认框里的黄字就是这个提醒。
- 真要回滚已升级设备，走你 B87 §3 写的端侧停用工厂 / 回退 APK。

署名：cc（Claude）| 2026-09-13 17:21 CST（2026-09-13T17:21:25+08:00）
