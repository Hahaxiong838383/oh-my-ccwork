# 给 codex：产品首句 v1 已在 worker/server 落地（分支，未上产），模拟器六场景全过——按 B23 字段接线即可

日期：2026-09-11 11:13 CST。承接 B23 提案；字段/事件名**未改**，以本文为准。生产 worker / 生产 Session API / 生产 env 零变更；改动都在分支 + 开发用隔离 unit。

## 0. 落地清单与锚

| 层 | 分支 / 提交 | 内容 |
|---|---|---|
| worker | `feat/ordered-pcm-input @ 94c203245`（骨架）+ `7f83c9438`（切换后 EndStream 修正）；home-studio 构建 sha256 `5365c86c3df280a1a9ac6b84…`；开发用隔离 unit `voice-worker-poc` MainPID 2576009（2026-09-11 02:49:12Z 起，**不是生产**） | 见 §1 |
| server | `feat/oneshot-first-turn-signing @ 4197a19fe`（从 main c649aca9d 开）：`P003GameDemo20260513/apps/server/src/routes/device-session.ts` + `scripts/device-session.test.ts` | 见 §2 |
| 工具 | `tools/opcm_poc_mint_rooms.py --first-turn v1`；`tools/opcm_device_sim.py` 新增 `--first-turn-meta / --rtc-only-meta / --no-begin / --rtc-wav / --rtc-delay-ms / --wav-head-ms`（64.90 同版） | 见 §3 |
| 测试 | worker `cargo test` **256/256**（+7：session 对撞 / no_task / no_final→no_task / outcome+next / 预算默认 / 唤醒词 ×2）；server **23/23**（+5） | |

## 1. worker：同房首句 → RTC（机制 = 终态即切 + STT 预连 + 追补环）

代码落点（`rust-worker/src/`）：
- `job.rs`：`JobMeta.oneshot_first_turn`；`OrderedCtx{local_receipt, first_turn_rtc, session_id}` 传给 `run_pipeline`（只认签发 metadata）。
- `ordered_pcm.rs`：`Limits.first_turn_rtc`；`Session::with_expected_session`（begin 头 `session_id` ≠ 签发值 → 只拒该消息 `session_mismatch`）；`Outcome::NoTask` / `Decision::NoTask`；`result` 加 `outcome:"task"|"no_task"|"failed"` 与 `next:"rtc"|"none"`；`no_final` 在 v1 下归 `no_task`；env `ORDERED_BEGIN_TO_END_TIMEOUT_MS`（默认仍 7000）/ `ORDERED_MAX_TOTAL_S`（默认仍 12）；evidence 加 `first_turn_rtc`，`outcome` 多 `no_task`。
- `textproc.rs`：`is_wake_only`（去空白/标点后 = 小可 ×1～3）。
- `control.rs`：`input_phase(...)` → `session.input_phase` 事件（壳与 `session.input_ready` 同）。
- `pipeline.rs`：`InputPhase{NotOrdered,FirstTurn,Rtc}`；首句期间 RTC 帧只计数 + **追补环 ≤1 s**；`end` 收流时**立即预连第二条 STT**；代次终态（committed / no_task / failed:*）或 **begin 超时**（`ORDERED_BEGIN_TIMEOUT_MS`=2500，input_ready 起算）→ 切换块：显式关首条 STT、接管第二条、只回灌 end 到达之后的追补帧（仅 committed/no_task）、发 `session.input_phase`、日志 `ordered_pcm input phase → rtc reason= catchup_samples= stt2_spawned_ms_ago=`；切换后 EndStream 动作不再碰发送端（7f83c9438 修的坑：begin 超时/取消路径的 fail→EndStream 在切换后到达会把第二条关掉）；ordered 首句 commit 不进开场重叠 VAD-less 放宽分支；`TTS_FIRST_CLAUSE_ORDERED_ONLY`（默认 1）= 逗号切只对 ordered 首句轮，未签设备零变化。

### 1.1 模拟器六场景（开发用隔离 unit，自铸房，journal 归档 `poc_journal_b23_sim_20260911.log.txt`，结果 `b23_sim_results.jsonl`）

| 场景 | 房尾 | result | `session.input_phase` reason | RTC 第二句 | 结论 |
|---|---|---|---|---|---|
| 首句→RTC（s02T 首句，s04T 第二句） | …5003 | complete / **task** / next rtc | first_turn_committed（STT2 预连 375 ms 前，追补 5920 样本） | 「一加一等于二」被识别 → 第二次 commit（VAD 路径，eou 578）→ 第二次回复，underrun 0 | ✅ 首答含逗号切「没问题呀，」；两轮各一次 commit，无双播 |
| 纯唤醒（合成「小可小可」1.21 s） | …5022 | complete / **no_task** / rtc | first_turn_no_task | 识别 + 回复 | ✅ worker 零招呼零垫句 |
| 无 begin（端侧没走首句） | …5037 | failed / timeout / rtc | **begin_timeout**（input_ready 后 2.5 s） | 「小可小可不要开灯」经 RTC 识别 + 回复 | ✅ 会话退化为普通 RTC，不死房 |
| 取消后 RTC | …5052 | failed / cancelled / rtc | first_turn_failed:cancelled | 识别 + 回复 | ✅ 不重试不重发 |
| 旧合同房（无 oneshot_first_turn） | …5065 | complete / task / **next none** | 无事件 | — | ✅ POC 一房一代语义不变 |
| 纯 RTC 房（生产同款 metadata，无 input_mode） | …5075 | 无 result | 无事件 | 经 RTC 识别 + 回复 | ✅ 未签设备路径不变 |

（无 begin 房的 RTC 回复出现 1 次 119 ms underrun，在普通 RTC 垫句→正文交接处，与切换无关，记着不归因。）

## 2. server：签发协商（P003GameDemo `device-session.ts`）

- 请求可选 `supports: string[]`（非数组/非字符串项忽略，≤16 项 × 64 字符）。
- `ONESHOT_FIRST_TURN_SN_ALLOW`（env，逗号分隔真实 SN，**空 = 全关**）∧ `supports` 含 `oneshot_first_turn_v1` → metadata 多签 `{input_mode:"ordered_pcm", oneshot_first_turn:"v1", local_receipt:"v1"}`，响应多 `contract:{input_mode, oneshot_first_turn, local_receipt, history_topic:"p003.audio.history.v1", worker_capabilities:["android_local_receipt_v1","oneshot_first_turn_v1"]}`；否则 `contract:null` 且 metadata 与今天完全相同。名单只看 env（不走 registry 的 active 判定）。
- 自检 `assertTokenMatchesResponse` 扩到 contract↔metadata 三字段同源；旧路径 metadata 必不含三键（负锚测试已加）。日志 ok 行加 `contract=first_turn_v1|-`。prefetch 不变、不承载合同。
- **未部署**：分支在本地；部署时名单为空 = 零行为变化，等川哥点头 + 你的端侧声明就绪再填 1 台。

## 3. 你接线要用的最终字段（与 B23 一致，逐条）

- 请求：`supports:["oneshot_first_turn_v1","local_receipt_v1"]`。
- 响应：`contract` 非 null 才走首句路径；null = 完全旧行为（不要看 SN 猜）。
- OPCM 包头：`session_id` 必须等于响应 `session_id`（现在会被对撞，错的只拒该消息）。
- `result`：`status` + `outcome`（task / no_task / failed）+ `next`（rtc / none）+ 旧字段。`no_task` = 你本地 greet 的场合，worker 不出声；`failed` 带 `reason` + `action:"repeat_prompt"`。
- 控制事件：`{"type":"session.input_phase","src":"worker","lane":"L2","trace_id","ts_ms","payload":{"room","phase":"rtc","reason","ordered":{"input_id","session_id","end_sample","outcome"},"stt_spawned_ms_ago"}}`，每 job 一次，可丢。
- 切换后端侧不需要发任何新包；mic 轨继续；`receipt_done` 照旧（切换后到达仍放行正文，模拟器已验）。
- 预算：首句 begin→end 12 s / 单代 16 s（开发 unit env 已设；生产默认值等定）；ACK 前包 ≥640 样本；begin 超时 2.5 s。
- 回声库：本地承接三条（「稍等哈。」「我想想哈。」「那个，让我捋捋。」）与你的 greet 文本要进 per-SN 回声库；纯唤醒房 worker 不出声，所以 greet 回声只可能经 OPCM 进首句代次——给我文本即可。

## 4. 未完与决定项

1. **worker 分支落后 main**（merge-base 在 device-session.ts 之前）：上产前先 `main → feat/ordered-pcm-input` 合并再构建；两条分支互不冲突（rust-worker vs apps/server）。
2. 七个 + 三个 env 的生产默认值（B23 §3.3 表 + `ORDERED_BEGIN_TIMEOUT_MS/ORDERED_BEGIN_TO_END_TIMEOUT_MS/ORDERED_MAX_TOTAL_S`）等川哥定；全部受签发 metadata 保护，未签设备不变。
3. 真机验收顺序不变（B22 §5）：纯唤醒→问题→第二句 / 连说→第二句 / 招呼交界 / 停·退出；灰度名单先 1 台。
4. 开发用隔离 unit 现在跑的是 WIP 二进制（5365c86c…），批次 5 余 …6366 没签 `oneshot_first_turn` = 旧合同房，可继续当回归锚；要真机验新合同得用生产 Session API 签（等 §2 部署）或我铸带 `--first-turn v1` 的房（你说一声）。

## 5. 归档与未 commit

归档 +2：`docs/oneshot-b6-20260909/{b23_sim_results.jsonl, poc_journal_b23_sim_20260911.log.txt}`（无 token / 无真实 SN）。mycc main 未 commit（等川哥 ①）：B22 分析（B23 提案）+ B24 本文 + 归档 2 + `tools/` 两脚本 + 新 HANDOFF；worker 与 server 改动各在分支已 commit 未 push。

署名：cc（Claude）| 2026-09-11 11:13 CST
