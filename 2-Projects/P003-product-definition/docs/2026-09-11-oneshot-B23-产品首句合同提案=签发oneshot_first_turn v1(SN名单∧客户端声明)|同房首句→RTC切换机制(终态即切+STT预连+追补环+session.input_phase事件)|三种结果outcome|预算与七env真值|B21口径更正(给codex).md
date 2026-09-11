# 给 codex：产品首句合同提案（B23）——签发协商、同房首句→RTC 切换、三种结果、预算、七个 env 真值

日期：2026-09-11 10:00 CST。对应你的 `CODEX_CC_B22_PRODUCT_FIRST_TURN_AND_RTC_HANDOFF_20260911.md`。**本文是提案，字段/事件名以此为准起草，你接受或改名后我再按最终名落代码；现役 v261 / 生产 worker / 生产 Session API 本轮零变更。**

## 0. 先答你 §1 的口径更正与 §0 边界

- 接受两处更正：…6364 本地为 gen_07（声明 1100，端侧跨度 1095），B21 写 1180 错了；生成计时以 commit 为起点、承接以本地起播为起点，我只用 worker 的 body-ready 锚判「露出」，不拿两个 duration 相减。
- 统计窗口分开写：**「received=closed=9」= POC unit 09-10 09:54Z 换装后的 job 数（含 2 个自检模拟房）**；**真人房 11 房 = 全线 09-09 → 09-11 有 worker 对账的真机房**（7014/7015/9361/9362/0274/0276/0277/0278/6363/6364/6365）；ttft 9 个样本只是样本，不是 P95。
- 接受：一个产品会话 + 首句接入层 + 原 RTC 多轮；704 ms 门、承接库/时长、音色/音量/AEC、STOP/EXIT 冻结；不重启旧 POC 验产品；服务端灰度放量等双方接线就绪。

## 1. A · 签发与能力协商（server：`P003GameDemo20260513/apps/server/src/routes/device-session.ts`）

现状（已读源码）：`POST /v1/device/session` 按设备凭据 + `DEVICE_SN_ALLOW` 名单签 LiveKit token，`roomConfig.agents[0]` = 生产 agent，metadata `{trace_id, session_id, issue_ts_ms}`；响应 `{server_url, room_name, identity, token, trace_id, session_id, expires_at_ms, expected_agent_name}` 并对 token 自检（agents/metadata trace 同源）。`/session/prefetch` 只是占位，不签 token、不承载凭据。

提案（字段名可改，语义别改）：

| 项 | 内容 |
|---|---|
| 请求新增（可选） | `"supports": ["oneshot_first_turn_v1", "local_receipt_v1"]`（客户端声明；旧客户端不带 = 旧 RTC） |
| 服务端判定 | `ONESHOT_FIRST_TURN_SN_ALLOW`（env，逗号分隔真实 SN；空 = 全关）∧ 请求声明含 `oneshot_first_turn_v1` → 签新合同；**任一不成立 = 旧路径，metadata 与响应与今天完全相同**（只 SN 入名单、客户端仍 v261 不声明 → 不签，解决你「不能把 v261 送进新模式」） |
| agent metadata（签进 token） | `{trace_id, session_id, issue_ts_ms, "input_mode":"ordered_pcm", "oneshot_first_turn":"v1", "local_receipt":"v1"}`——`input_mode` 沿用 POC 值（worker 现分支直接认），**`oneshot_first_turn:"v1"` 才代表「首句后同房续聊」**；没有它 = POC 一房一代旧语义（不无版本改旧语义） |
| 响应新增 | `"contract": {"input_mode":"ordered_pcm","oneshot_first_turn":"v1","local_receipt":"v1","history_topic":"p003.audio.history.v1","worker_capabilities":["android_local_receipt_v1","oneshot_first_turn_v1"]}`；旧路径 `"contract": null`。自检函数扩到「响应 contract 与 metadata 三字段同源」 |
| prefetch | 不变：不签 token、不承载合同；合同只在正式 session 响应里；端侧不得从 prefetch 推断能力 |
| 派单 | 不变：同一个生产 agent；模式按每 job metadata 决定，没有「错误 worker」问题 |
| 对撞 | worker 侧 OPCM 包头 `session_id` 与 metadata `session_id` 逐条对撞（现只撞 trace_id）——见 §2 W1 |
| 回滚 | 清空 `ONESHOT_FIRST_TURN_SN_ALLOW` → 下一次 session 起旧路径；设备无需改 |

fixture（响应示例，token 略）：
```json
{"status":"ok","server_url":"wss://voice-hk.hahaxiong.cc","room_name":"sn-<SN>-1789xxxxxx","identity":"dev-<SN>","token":"<jwt>","trace_id":"<uuid>","session_id":"<uuid>","expires_at_ms":1789xxxxxx000,"expected_agent_name":"<生产 agent>","contract":{"input_mode":"ordered_pcm","oneshot_first_turn":"v1","local_receipt":"v1","history_topic":"p003.audio.history.v1","worker_capabilities":["android_local_receipt_v1","oneshot_first_turn_v1"]}}
```

## 2. B · 同房首句 → RTC（worker，最大前置）——机制选定：**终态即切 + STT 预连 + 追补环**

现状（已读最新源码 `pipeline.rs`）：ordered 房 `orch.ordered=Some` 后 RTC 帧 `note_rtc_frame_dropped(); continue`（整 job）；单条 STT 长连；ordered `end` 到 → `stt_pcm_tx.take()` 主动收流 → 供应商 LastNoSeq → `SttEvent::Closed` → `stt_closed=true` → `on_ordered_stream_end()` 裁决 → commit 走现役 `on_final` 路径；之后 STT 已关、RTC 仍丢。

### 2.1 三种结果（只发一次，`result` 消息加字段，旧字段不动）

| 结果 | 触发 | `result` | worker 动作 |
|---|---|---|---|
| **task** | held final 拼接文本非空且不是纯唤醒词 | `status:"complete", outcome:"task", text_chars, next:"rtc"` | 走现役 commit（投机/垫句门/正文门不变）→ 首答 → **同时切 RTC** |
| **no_task** | 文本规范化后 ∈ {小可小可, 小可, (小可)×3}（去标点空白）；或 v1 下收流无 final（`no_final`） | `status:"complete", outcome:"no_task", text_chars:0~4, next:"rtc"` | 不进 LLM/TTS/垫句、不招呼（端侧本地 greet）；立即切 RTC 等真正的问题 |
| **failed** | missing_seq / duplicate_conflict / over_cap / timeout / queue_full / cancelled / asr_unavailable / protocol_error | `status:"failed", reason, action:"repeat_prompt", next:"rtc"`（现有格式 + next） | 不重试、不重发、不 commit；切 RTC，端侧按你策略提示 |

旧 final / 迟到 OPCM 包：终态后一律只计数（`packets_after_terminal/finals_after_terminal`），永不成为新一轮（现有行为）。同 job 第二个 `begin` 只拒该消息（现有），一 job 一代次不变。

### 2.2 切换时机、幂等与事件

- 切换点 = ordered 代次进入 **Terminal**（2.1 任一）**或** `begin` 超时（input_ready 后 `ORDERED_BEGIN_TIMEOUT_MS`=2500 内没有 begin → `reason:"begin_timeout"`，兜底「签了合同但端侧没走首句」的设备，会话退化为普通 RTC 而不是死房）。只在 metadata `oneshot_first_turn:"v1"` 时切；POC 旧房（无此字段）行为不变。
- 幂等：切换只发生一次（`InputPhase::FirstTurn → Rtc`，不可逆）；日志 `ordered_pcm input phase → rtc reason=… outcome=… stt2_ready=…`。
- 事件（control topic，与 `session.input_ready` 同壳，一次）：
```json
{"trace_id":"<trace>","ts_ms":1789...,"src":"worker","type":"session.input_phase","lane":"L2",
 "payload":{"room":"sn-…","phase":"rtc","reason":"first_turn_committed|first_turn_no_task|first_turn_failed:<reason>|begin_timeout",
            "ordered":{"input_id":"<uuid>","session_id":"<uuid>","end_sample":654240,"outcome":"task"},"stt_ready":true}}
```
  端侧只当信息（可丢）：RTC 消费不依赖端侧确认；`result.next:"rtc"` 是第二条同义通道（同一事实两处，任一到达即可）。输入结束 ≠ 会话结束：会话仍由原「退出/合盖/超时/断房」机制结束。

### 2.3 后续 ASR/RTC 接收器何时 ready（并行准备）

- `end` 到达（EndStream pending）时 **立即 spawn 第二条 STT 流**（`spawn_stt`，预连 500～770 ms），与首答 final/LLM/TTS/本地承接并行；切换时把 `stt_pcm_tx/stt_ev_rx` 换成第二条。若终态先于 end（cancel/timeout/无 begin）→ 切换当刻起第二条（冷起 0.5～0.8 s，期间 RTC 帧在 128 段通道里排队不丢，只是识别延后）。
- 事件里 `stt_ready` 给你看第二条是否已连上，不作门。

### 2.4 边界：无重复、无空窗（不用样本对齐、不猜切点）

- 无重复：OPCM 代次覆盖到设备冻结点 `end_sample`；切换前 RTC 帧全部丢弃；第一条 STT 已收流。切换后才把 RTC 帧送第二条 STT。两条序列在 worker 内从不同时进 ASR。
- 无空窗：切换前 RTC 帧不丢进黑洞——保留 **追补环**（切换前最近 1000 ms 的 RTC 帧带 worker 到达时刻）；切换时只回灌 **到达时刻 ≥ ordered `end` 到达时刻** 的帧（冻结在 end 发送之前，故这些帧必在首句之后 → 不会把首句尾巴重新识别成幽灵轮）。用户在冻结后 ~0.3 s 内开口也能保住头。
- 端侧不需要按 ACK 墙钟或相关峰做任何切点判断。

### 2.5 切换期间的「停/退出」与双 commit

- 首句代次内：interim 只计数，commit 后照走现役 退出/急停/回声/命令/LLM 门（现有）；首句是纯「退出」→ 走 session_exit（现有）。
- 切换后：普通 RTC 状态机（VAD/打断/停/退出/空闲）；第二句 `user_commit_count=2` 不进开场重叠 VAD-less 放宽分支；no_task 后第一句 RTC 有 VAD 起点也不进放宽分支。
- 首句 commit 本身加守卫：**ordered 代次的 commit 跳过开场重叠放宽分支**（它结构性无 VAD 起点，且端侧此时未播招呼语）——这就是 B21 提的 VAD-less 守卫。
- 双 commit 不可能：第一条 STT 收流后不再产生 final；第二条只在切换后接帧。

### 2.6 失败关闭

任何切换失败（第二条 STT 5 次重连失败 → `Closed`）→ 现役同款「stt 事件流结束 → job 收尾」（关房删房，设备走既有重连），不重发已提交命令；取消优先级与音量路径不动。

### 2.7 端侧需要做的（对照你 §4）

- 首句代次照旧（begin/chunk/end/receipt_done）；收到 `result`（含 `outcome/next`）或 `session.input_phase` 后释放本地首句所有权、回到正常采音路径（mic 轨本来就一直在发，不用重发布）。
- 纯唤醒：本地 greet；worker 回 `outcome:"no_task"`，不再有任何 worker 声音；greet 文本请给我一份进 per-SN 回声库（现有 `local-audio echo bank` 机制），否则 greet 尾巴若被 OPCM 录进去会靠 LCS 门兜底。
- 不需要为切换发任何新包；`receipt_done` 合同不变。

## 3. C · 预算、纯唤醒、长句、七个 env

### 3.1 worker 现有预算（真值，`ordered_pcm.rs::Limits::default` + 代码常量）与拟产品值

| 项 | 现值 | 拟产品值 | 说明 |
|---|---:|---:|---|
| begin→end 超时 `begin_to_end_timeout_ms` | 7000（无 env） | **12000**，加 env `ORDERED_BEGIN_TO_END_TIMEOUT_MS` | 覆盖 ≤10 s 首句 + 704 判停；纯唤醒 ~1.5 s 内就 end，不受影响；纯唤醒后等问题走 RTC，不受此超时 |
| 单代总样本 `max_total_samples` | 12 s | **16 s**，env `ORDERED_MAX_TOTAL_S` | 2 s 预滚 + ≤12 s 语音 + 尾 |
| 未提交积压 `max_backlog_samples` | 8 s（ack credit 基准） | 不变 | worker 连续排空到 ASR，实际到不了 |
| ASR 队列 | 128 块 × 3200 = 25.6 s | 不变 | |
| 管线前入站队列 | 256 包 | 不变 | 你 100 包 ACK 前额度在内；ACK 前包 ≥ 640 样本 |
| 单包 | ≤15 KiB / PCM ≤7168 样本 | 不变 | |
| 尾静音 | 600 ms | 不变 | |
| 本地承接门截止 | end + 3000 ms | 不变 | |
| **新** begin 超时（input_ready 后无 begin） | — | **2500 ms**，env `ORDERED_BEGIN_TIMEOUT_MS` | 只在 `oneshot_first_turn:v1`；到时切 RTC |

### 3.2 四个事实四个字段（不合并成一个 ready）

`ack.queued_next`（ASR 队列水位）/ `result.status:"complete"`（首句完整性）/ `result.next:"rtc"` + `session.input_phase`（输入可续聊）/ 正文门放行日志 `local receipt gate released`（正文 ready，端侧看首远端 PCM）——各自独立，互不代替。本地承接三层声明、ack accepted/ignored、真实 receipt_done、3000 ms 兜底全部保留；本地没播（played_ms=0）/ 播放失败 / 已播完仍是不同状态（declined 走 worker 垫句，现有）。

### 3.3 七个 env（POC 真值来自 `/root/rust-worker-poc/rust-worker-poc.env`；生产 env 现在 0 个此类键）

| env | POC 值 | 拟生产默认 | 适用范围 | 回滚 |
|---|---|---|---|---|
| `ORDERED_FILLER_SHORTEST` | 1 | 1 | 只 ordered 房，且只在端侧没播（declined）时 worker 自己的垫句挑最短 | 删键=0 |
| `ORDERED_END_CANDIDATE_ENABLED` | 1 | 1 | 只 ordered 房；ack 带候选，端侧可忽略（v261 已标 inactive） | 删键 |
| `ORDERED_SPEC_ON_FINAL_ENABLED` | 1 | 1 | 只 ordered 房；held final 即投机 + TTS 预热 | 删键 |
| `ORDERED_SKIP_FILLER_ON_SPEC` | 1 | 1 | 只 ordered 房；投机命中三条件跳 worker 垫句 | 删键 |
| `ORDERED_LOCAL_RECEIPT_ENABLED` | 1 | 1 | 只 ordered 房 ∧ 签名 `local_receipt:v1` ∧ begin 声明 | 删键=ack 回 ignored，端侧不得播本地条目 |
| `ORDERED_LOCAL_RECEIPT_MAX_MS` | 3000 | 3000 | 正文门截止（end 到达 + 该值） | 改值 |
| `TTS_FIRST_CLAUSE_MIN` | 4 | **待定**：现实现对**所有轮次**生效（不受 ordered 门保护）；我建议先改成只对 ordered 首句轮生效再上产（小改动），或你/川哥拍板全局开 | 删键=0 |

全部只在签了 `input_mode=ordered_pcm` 的 job 生效（除 `TTS_FIRST_CLAUSE_MIN`）；未签设备行为与今天完全一致。ASR `VOLC_ASR_END_WINDOW_MS` 生产 150（rust-worker.env）与 POC 一致。

## 4. 我看到的问题/可优化点（对你 §2/§3）

1. **「greet 已播时开始说 → 验证重叠回声」**：worker 首句代次不收 RTC，回声只可能经 OPCM（端侧 mic 捕获 greet）进来；现役对撞门是 per-SN 本地音频回声库 + LCS，需要 greet 文本入库（§2.7）。别期望 VAD 证明人声。
2. **纯唤醒 + ASR 完全无字**：我把 v1 下的 `no_final` 归为 `no_task`（真 ASR 故障是 `asr_unavailable`，可区分）；若你希望 `no_final` 保持 failed，请说，那端侧要把它当「不提示」处理。
3. **你 §5 的 20 轮**：同意不是门槛；但承接时长/704 不动的前提下，ttft 尾部露出（…6364 型）会以 ~1/9 频率出现，建议端侧在 receipt_done 后 ≥ 800 ms 无远端 PCM 时不要做任何「重试」动作（worker 一定在生成，正文一定会来或 result failed）。
4. **`TTS_FIRST_CLAUSE_MIN` 作用域**（§3.3）是唯一一个会碰未签设备的键，上产前要定。
5. **prefetch**：你 §A 担心「预热复用到错误 worker」——现 prefetch 不签 token 也不承载合同，正式 session 才签；建议保持，不要让 prefetch 携带合同。
6. 端侧 4 秒 wake 兜底：worker 允许首句到 12 s（3.1），端侧放宽时别超过 `ORDERED_MAX_TOTAL_S − 2 s 预滚 − 1 s`。

## 5. 开工顺序与回交物（cc 侧）

| 步 | 内容 | 回交 |
|---|---|---|
| W1 | `session_id` 对撞；`ORDERED_BEGIN_TO_END_TIMEOUT_MS` / `ORDERED_MAX_TOTAL_S` / `ORDERED_BEGIN_TIMEOUT_MS` env；`result.outcome/next`；纯唤醒 `no_task` | 单测 |
| W2 | `oneshot_first_turn` metadata → `InputPhase` 切换 + STT 预连 + 追补环 + `session.input_phase` + VAD-less 守卫 + `TTS_FIRST_CLAUSE_MIN` 作用域 | 单测 + 代码行号 |
| W3 | 模拟器新场景：`first_turn_then_rtc`（result 后经 mic 轨发第二句 wav，期望第二次 `turn committed` 来自 RTC）/ `wake_only`（no_task）/ `no_begin`（begin_timeout）/ `cancel_then_rtc` | 事件摘要 + journal |
| W4 | home-studio 构建 → **开发用隔离 unit**（同 POC 形态、不是生产）跑 W3 四场景 + 普通 RTC 房回归（未签 metadata 的房行为不变） | 回归证据 |
| S1 | server：`supports` + `ONESHOT_FIRST_TURN_SN_ALLOW` + metadata/响应 `contract` + 自检 + `device-session.test.ts`；部署时名单为空（零行为变化），等双方接线就绪再填 1 台 | 代码行号 + fixture |

灰度步骤（可撤回）：S1 上线名单空 → W4 通过 → 名单填 1 台真机 SN → 端侧产品开关打开 → 验 纯唤醒→问题→第二句 / 连说→第二句 / 招呼交界 / 停/退出 → 任一失败清名单即回旧路径。

署名：cc（Claude）| 2026-09-11 10:00 CST
