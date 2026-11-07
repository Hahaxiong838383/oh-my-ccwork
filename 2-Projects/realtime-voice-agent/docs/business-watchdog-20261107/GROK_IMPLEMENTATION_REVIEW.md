# 业务无进展保护：实现前合同复审

2026-11-07T21:21:46+08:00。只读。未改业务源码，未操作生产，未派代理，未跑测试套件。

基线：本工作树干净 `c19e0964`，分支 `codex/p003-voice-transport-fix-20261105`。倾听候选树干净 `18048235`，分支 `codex/p003-listening-worker-20261030`。生产 Brain 路由以取证文件 `BRAIN_ROUTE_FULL_SOURCE.ts` 为准，SHA256 `3356e98effed3586f2d66746014191f58156626f57d3661ae963955670178834`。本工作树 `device-session.ts` 是 `e98214694233c66ebe2f5fd5edac55756b63c239b95a06748175707f7abfe102`，v384 本地副本是 `6763d2275f935b808e14415482f51103f1ffb449af34ff6508c23e8caf2fe531`，两份都不是这枚生产哈希。

共同方案不变：先观察，再按精确 room SID 关闭；60 秒产品空闲已撤回；DeleteRoom 的 2xx 不是成功。本文件只给主 Codex 可落地的最小合同。02000053 的真实 `timeout_ms` 仍未知，下面不用该房的原始音频推断秒数。

## 阻断

1. **不能把新产品空闲接进现有 5 秒心跳或启动 60 秒。** `job.rs` 的看门狗只在 `pipeline_task` 已存在、`beat > 0` 且墙钟落后超过 5 秒时关房。`pipeline.rs` 1050 行每 50ms 写心跳，无对话也写。`StartupParticipant::new` 的 `deadline_ms = 60_000` 只在 `!started` 时生效；`job.rs` 396 行在用户轨订阅时就把 `started` 置真，之后 `expired()` 恒假。订轨后的零帧房、以及 `input_ready` 之前的房，这两条旧时钟都盖不住。若把 60 秒硬编码成空闲阈值，会误关已签 300 秒的房。

2. **`prebuild` 的等待不在看门狗的 `select` 里。** `job.rs` 483–495 行在房间事件分支内直接 `h.await`。此时 `started` 已经为真，`next_job_wake` 不会跑。`prebuild` 不返回，5 秒心跳和启动宽限都看不到。合同要求这次等待自己有截止，截止到了走现有 `break` 收尾，不另开一条删房路径。

3. **当前受信 metadata 没有空闲策略。** 生产签发体（取证文件约 375–386 行）只有 `trace_id`、`session_id`、`issue_ts_ms`、`filler_policy`，外加可选的 `listening`、`search_canary` 和首句三字段。没有 `voice_idle`。`JobMeta`（`job.rs` 40–57 行）也没有该字段，且没有 `deny_unknown_fields`，旧 worker 会忽略多出来的键。v384 本地 `CONFIG_KEYS` 未见 `voice.session_idle_timeout_sec`；这只说明该本地树没有，不能代替生产 `config-store` 哈希。Android `VoiceIdlePolicyStore` 能解析 `voice.session_idle_timeout_ms`（5000..=300000，缺键则解析失败，`resolve` 回退 5000）。那是端侧缓存，不是 worker 的受信输入。worker 读设备自述、data packet 或把缺键当成 5000/60000，都不符合合同。

4. **普通房没有候选池的清理对账。** `room_cleanup.rs` 62–63 行：非候选 agent 或未开 `P003_ROOM_CLEANUP_V1` 时 `CloseIntent::begin` 返回 `Ok(None)`。`delete_room` 在 HTTP 2xx 时直接返回 true（`job.rs` 631–633 行），调用点把返回值丢掉（518 行），随后仍打 `job closed`。候选池的持久对账不能算普通 RTC 已核对 SID。

5. **不要把倾听候选的布尔值移植进主池。** 主池源码没有 `listening_adapter`。候选池 `listening_adapter.rs` 用 `grant_expires_at_ms` 和约 5 秒的续租；`search_control_recovery.rs` 的 `listening: bool` 可以一直为真。主池本轮只保护普通 RTC。倾听池要同一规则时另做，一边通过不覆盖另一边。

## 时钟

用 `Instant`，从 `run_job` 已有的 `t0` 起算。不用 `SystemTime` 做这个判决。现有心跳继续只负责主循环卡死。

两条时钟分开，禁止混用：

| 时钟 | 何时走 | 阈值 | 禁止 |
|---|---|---|---|
| 启动参与者宽限 | 仅 `!started` | 维持现有 60 秒总预算、离开后 3 秒、替换后 10 秒 | 不要放宽到 300 秒，也不要把它当成订轨后的空闲保护 |
| 业务无进展 | `started == true` 之后，含 pipeline 已跑、零帧、以及 `prebuild` 等待 | 见下方策略 | 不要等 `input_ready`、`begin` 或 `beat > 0` 才武装 |

`started` 之后没有任何受保护进展时，截止从置位时刻算，不从首帧、ready 或 begin 算。`begin_timeout` 仍只切回 RTC，不关房。

策略只来自 Brain 签进 `job.metadata` 的对象，进房时解析一次，房中途不改：

```json
{"voice_idle":{"timeout_ms":300000,"revision":"<config revision>"}}
```

- `timeout_ms` 必须是 JSON 整数，闭区间 5000..=300000。字符串、小数、null、0、4999、300001 都算无效。
- 有效值就是产品空闲。已签 300000 的房，无进展 299 秒不得关，满 300000 毫秒才可关。实现里出现常量 60000 作为该判决，即失败。
- 缺字段或无效：不得用 60000，也不得一直开着。关闭开关打开时，用已有合法上限 **300000** 做未配置天花板，原因码 `policy_absent_ceiling`。这是 Android 解析器里已经写明的上限，不是新测出来的体验阈值。已签 300000 的原因码必须是 `signed_idle`，两条测试都要在。
- 观察开关不能是一只永久为真的布尔。它只能是带截止时间的 SN 名单：到期前只记 `would_close`，到期后缺策略走天花板。没有截止的观察模式，等于这个缺口继续无保护。

## 什么算进展，什么不算

重置业务时钟的只有下面这些，而且每一项仍受自己的旧截止约束。旧截止到了，该项不再续命。

- 本房、本 trace 的 ASR final 被接受的那一下。interim 连续到来只算「一句还没结束」，必须绑到现有 EOT。本轮没有找到可直接复用的长语音总时长常量，PR 要写明它接的是哪一个现有常量。接不上就不要用产品空闲或 60 秒去截断正在说的话。
- 现有 VAD 判定为语音且幅度非零的帧。幅度只记标量。全 0 帧、帧数、mute/unmute 都不重置。
- 正在向输出轨送出新 PCM。`agent_turn.is_some()` 本身不续命；没有新 PCM 的轮次按无进展处理。
- 搜索：`poll_until`、`speech.expires` 或 `result_until` 仍在未来，且不超过现有提交后约 80 秒的轮询窗。`SearchSession.busy`、`auto_pending`、`dialogue_changed` 的 300 秒上下文窗都不续命。
- 设备命令：沿用 `pending_cmd` 与 `DEVICE_RESULT_DEADLINE`（8 秒，已 ack 后 24 秒）。超时后现有失败句逻辑照旧，不另加无限等待。
- 倾听租约只在「worker 确有该适配器且 `grant_expires_at_ms` 仍在未来」时续命。主池没有适配器，metadata 里的 `listening` 对象忽略，不当作忙碌。

明确不重置、也不能单独当关闭依据的：50ms 心跳、`input_ready` 及其 request/restated、`output_ready`、参与者仍 ACTIVE、零帧、没有 ASR final、`input_ready_fired`、`gates`、搜索 `busy`、候选 `listening` 布尔。没有 final 不是关闭条件；关闭条件是「没有上述受保护进展，直到策略截止」。

## 接线

Worker，只动本工作树 `rust-worker`：

- `job.rs` `JobMeta`：增加 `voice_idle`。非法则记 `policy_absent_ceiling` 并走天花板，不回退 60 秒。
- `job.rs` `JobWake::Watchdog`：`pipeline_task == None` 时也检查业务截止。`started` 之前仍只走 `StartupParticipant`。
- `job.rs` 483 行：`timeout(剩余预算, prebuild join)`。超时 `break`，进入现有 `close_pipeline` / `close_room_and_delete`。
- `pipeline.rs` 50ms tick：只在上面列出的真实进展处写单调进度戳。不要在写 `beat` 的同一行写进度。
- 关闭仍从 job 循环 `break`。删房后用房间服务按**原 room SID**读回：房间不在，且设备与 agent 两个 participant SID 都不在。2xx、`job closed`、清理意图写成 closing，三者都不得标 PASS。读回失败记 `cleanup_unconfirmed`，不重签、不在 prefetch 时删旧房。
- 日志带 room SID、trace、原因码、策略 revision、剩余毫秒。不记正文和音频。

Brain，改部署中的那份源码，不改本工作树这份旧 `device-session.ts`：

- 在 `CONFIG_KEYS` 注册 `voice.session_idle_timeout_sec`，整数 5..=300。未注册或该 SN 无有效值时，metadata **省略** `voice_idle`。不要另造一个会让 worker 采用 60 秒的默认。
- 签发时读 `configStore` 的有效快照（SN 覆盖优先于全局），乘 1000，与快照 `revision` 一起放进 `agents[0].metadata`。不读请求体里的超时。
- `assertTokenMatchesResponse` 增加这一键的同源断言。prefetch 仍不签 token。
- 先发 Brain 是安全的：旧 worker 会忽略未知字段。worker 先发也可以，因为缺字段走天花板而不是 60 秒；但观察名单未到期前不应全量开删。

## 测试反例

只列必须先红后绿的例子。未跑。

| 例子 | 必须发生 |
|---|---|
| 心跳每 50ms 更新，订轨后幅度恒 0，已签 300000 | 299 秒不关，300 秒走 `signed_idle` |
| 同上但 metadata 无 `voice_idle`，关闭已启用 | 按 300000 走 `policy_absent_ceiling`，不按 60000 |
| `timeout_ms` 为 `"300000"`、300001、4999 或来自 data packet | 与缺字段相同，不采纳该值 |
| 未订用户轨 | 仍是现有启动 60 秒，不被天花板放宽 |
| 已订轨、pipeline 未启动、`prebuild` 不返回 | 在剩余预算内离开等待并收尾 |
| `input_ready` 每分钟重述，帧数为 0 | 不重置 |
| 非零语音跨越产品空闲，或搜索 `poll_until` 未到，或命令未到 8/24 秒 | 不关；对应旧截止到了之后不再续 |
| `busy==true` 且没有未来截止，或 `agent_turn` 在但没有新 PCM | 不续命 |
| 主池 job metadata 带 `listening` | 不续命 |
| DeleteRoom 2xx 但原 SID 仍在 | `cleanup_unconfirmed`，测试失败 |
| pipeline 返回 Err、panic 或 abort | 11 月 6 日的收尾和容量释放仍在 |
| 新票未 connect、prefetch | 不删另一个健康 SID |

## 部署顺序

1. 本工作树补上述测试并实现 worker。不部署。
2. 在与 `3356e98e` 同族的 Brain 上注册配置并签发 metadata。用一张非目标 SN 的票据解码核对，不靠本工作树旧文件。
3. 单机装 worker。观察名单只含目标 SN，且带截止。先看 `would_close` 的原因码和 revision，不删房。
4. 名单到期或明确打开关闭后，只对目标 SN 做合成零帧和一段正常语料。关闭后独立读回原 SID 和两名参与者，并确认 worker 任务槽释放。
5. 主池与倾听池分开验收。本轮不合并 `18048235`。
6. 回滚先关该 SN 的关闭开关。二进制回到 `35f59ecde2ce892f0c865ae90880747a00f782cccbffe39abe5dc3234e464971` 所对应的 `991ee2a38694414b447d3db8ff29a8cda39aee5f`，工作树文档头为 `c19e0964`。不整树回退，以免丢掉 11 月 6 日的生命周期修复。

未完成：保护代码、测试执行、生产部署、端侧实机。无有效输入的起因和后 12 张票仍未定。

署名：Grok 4.7（xAI）
