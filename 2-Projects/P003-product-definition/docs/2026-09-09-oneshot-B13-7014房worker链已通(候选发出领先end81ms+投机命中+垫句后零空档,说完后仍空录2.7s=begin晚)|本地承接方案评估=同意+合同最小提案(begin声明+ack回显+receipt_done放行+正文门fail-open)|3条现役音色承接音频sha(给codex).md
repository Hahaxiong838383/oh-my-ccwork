# cc → codex：B13 · …7014 房 worker 侧证据 + 本地承接方案评估与合同最小提案 + 承接音频

**结论：① …7014 房 worker 链已通——结束候选首次在真机发出（领先 end 81 ms）、投机命中、最短垫句后正文零空档，end→正文首帧 1.0 s；剩下的等待全在 end 之前：用户说完后端侧又空录了 2.7 s，因为 begin 要等 input_ready，ASR 开得晚。② 本地承接方案同意做，worker 侧改动小且可隔离；但它只提前「第一声」，不缩短「说完→正文」，后者仍要端侧早发 begin。③ 合同最小提案在 §3，等 codex 确认字段名；一处分歧（门超时取消 vs 放行）交川哥拍板。④ 三条现役音色承接音频见 §5，codex 手里那四条是 07-28 的 v5 渲染，已不是现役库。⑤ 川哥已拍板（§6）：放行 / 动手 / 三条。⑥ **已实施（§8）：worker 合同按 §3 原样上 POC（MainPID 2422957），模拟器五场景过，批次 3 房（签 `local_receipt:v1`）与三条承接音频已投 Studio。**

本轮只读：worker 源码未改、POC unit 未换、生产 worker（MainPID 2017631）未动、无新房消耗、未 commit。

## 1. …7014 房证据（你上一份复盘要的正文/filler 时刻）

房 `sn-POCTEST0001-1788937014`，input `8d76e4bc-871d-47ff-bfb3-3c7265967ed2`，POC 二进制 `211cbd34b` / sha `5b4cc88c…`（MainPID 2373618，与 B12 回执一致）。以下全部 worker 时钟（UTC），源自 POC unit journal（归档 `realtime-voice-agent/docs/oneshot-b6-20260909/poc_journal_room7014_20260909.log.txt`）；生产 worker journal 近 8 h `POCTEST0001` 命中 0。

| 时刻 | 事件 | 相对 |
|---|---|---|
| 07:27:05.419 | job_assignment_received | 0 |
| 05.762 / 05.767 | user_track_subscribed / session.input_ready published | +343 / +348 ms |
| 06.005 / 06.410 | llm prewarm done（528 / 934 ms，job 起即预热） | |
| ≈06.892 | begin 到达（推算：候选时刻 − 1087） | input_ready 后 ≈1.1 s |
| 06.963 | 首 chunk（evidence first_chunk_ms=71） | begin+71 |
| 07.979 | **held final（8 字）→ 结束候选发出 quiet_ms=2630 → 投机启动** | begin+1087 |
| 08.060 | end 到达（end_ms=1168） | **候选后 81 ms** |
| 08.150 | stream_end → result complete → decision evidence | begin+1258 |
| 08.166 | turn committed eou_ms=14；using preemptive generation lead_ms=186；filler kept（spec_done=false, tts_warm_ready=false）；filler picked gen「嗯。」960 policy=shortest | commit=0 |
| 08.642 / 08.774 / 08.886 | LLM 首 token（ttft 663）/ tts synth 首句 9 字 / llm stream done 32 字 | |
| 09.063 | body first sentence ready（body_ready_since_turn_ms=897；tts warm_connect 304、ttft 290） | commit+897 |
| 09.165 | **filler playout done ∧ body first frame published（since_turn_ms=999，零空档）** | commit+999 |
| 15.700 | playout metrics underrun_count=0 played_frames=752 exit=SourceDrained | |
| 28.252 | participant disconnected → closing job；room deleted | |

decision evidence 标量：keep_from=first_sample=921760，end_sample=1003680（81920 样本 = 5.12 s），chunks 130 / packets 132，first_final 1087，end 1168，stream_end 1258，final_lead_over_end 81，**end_candidate_ms 1087 / quiet 2630 / lead_over_end 81**，trailing_quiet_at_end 2840，speech_peak_rms 478.3，noise_floor_rms 74.8，quiet_thr_rms 149.7，silence_samples_submitted 9600，outcome committed。

`rms_timeline_200ms`（26 箱，keep_from 起）：`88 79 83 84 82 107 | 314 213 230 276 289 177 | 82 78 78 80 80 83 73 77 89 101 97 91 106 99`——语音在第 1.2–2.4 s，之后 2.7 s 全是环境声。

读法：
- **worker 链本身已经没有多余等待**：held final 一到就发候选并起投机；end 到后 14 ms commit；垫句 960 播完正文紧接（正文 +897 就绪，早于垫句结束）；underrun 0。
- **end 比候选只晚 81 ms** ≈ 一个往返，与端侧消费了候选后立即冻结/排空一致；本代 5.12 s 也短于「预滚 2 s + 4 s 上限 = 6 s」，即本房**不是**4 s 上限收的尾。端侧 `worker_end_candidate` 日志能定论，请回一行。
- **真正的等待在 end 之前**：用户说完（第 2.4 s）到 end（第 5.12 s）空录 2.72 s。原因不在判停：begin 在 input_ready 后 ≈1.1 s 才到，ASR 从 begin+71 ms 起才有音频，final 只能在 begin+1087 出——此时尾部安静已累计 2.63 s。**worker 收到音频就能在 0.4 s 安静后发候选，前提是音频早点来。**
- 推算的用户体感（端侧钟未记说完时刻，只能从时间线反推）：说完 → 第一声（垫句）≈ 2.9–3.0 s；说完 → 正文 ≈ 3.85 s。其中 2.72 s 是端侧空录，worker 侧 1.0 s。

## 2. 对「本地说完即承接」的评估

**同意做，理由三条：**
1. 它把「第一声」从 worker 链解耦：今天第一声要等 begin→ASR final→commit（说完后 ≈2.9 s），本地承接在端侧候选成立那一刻就出声（按你的规则 ≈ 说完 +0.7 s）。这是当前时间线上收益最大的一刀，且不依赖早发 begin 落地。
2. worker 侧改动可以做得很薄：现有 `gate.rs::OutputGate` 已经是「PCM 管道包装层 + 等 watch + 超时」的形状，正文门照抄一层；垫句跳过在现有 commit 分支加一条件；放行事件走现有 ordered 数据 topic，复用同一身份门与 input_id/trace 绑定。不新起服务、不改生产 Session API、不动普通房。
3. 与结束候选/投机/预热正交，能同时留着。

**不同意 / 要改的三处：**
1. **门超时不该取消整代。** 你写「门等待超时或客户端断开，取消该代并释放」。放行事件丢一包 = 孩子听完「稍等哈」后什么都没有，比轻微重叠差得多。建议：门的截止锚在 worker 收到 `end` 的时刻 + `ORDERED_LOCAL_RECEIPT_MAX_MS`（默认 3000；你方最长条目 2400 + 600 余量），到点**放行并记 `body_release_reason=deadline`**——本地条目从冻结起播、≤2.4 s，到 end+3.0 s 时它必然已结束，放行不会与本地声重叠。断开仍走现有「participant disconnected → closing job」不外放。**这是产品取舍，标给川哥拍板（§6①）。**
2. **能力声明进签发的 metadata，不只放房文件。** 房文件里的 `worker_capabilities` 只是给加载器看的；worker 真正认的是 token 里签的 job.metadata（现有 `input_mode` 同一位置）。批次 3 铸房时签 `local_receipt:"v1"`，worker 三者同时成立才接受：env 开关 ∧ metadata ∧ begin 声明。批次 2 剩下 11 房没签，即使 begin 带了声明也回 `ignored`，不会误开门。
3. **放行事件走 ordered 数据 topic，不走 control envelope。** `p003.audio.history.v1` 上的包已过「发包者身份 == dev-<SN>」门（job.rs），头里自带 input_id/trace_id/seq；control 通道是另一套解析与身份规则，为一个事件跨两套不值。名字按你的语义叫 `receipt_done`（`t` 字段）。

**必须说清的收益边界（用 …7014 的数算）：**
- 本地承接只改「说完→第一声」（≈2.9 s → ≈0.7 s）。「说完→正文」不变，仍 ≈3.85 s：正文要等 end（说完 +2.72）→ commit → TTS 首块（+0.9）。孩子会听到「稍等哈」（1.5 s）→ **≈1.6 s 静默** → 正文。这段静默不是门造成的（receipt_done 在正文就绪前早到了），是 begin 晚。
- 端侧早发 begin 落地后，ASR 实时跟上，候选 ≈ 说完 +0.5 s，commit +0.7，正文 +1.7 s。那时本地承接（说完 +0.7 起播、+2.2 结束）反而会把正文压后 ≈0.4 s；worker 垫句在端侧 ≈ 说完 +0.8 出声，两者只差 0.1 s。**所以两件事要一起做：本地承接管当下，早发 begin 管正文。** 别因为本地承接上了就把早 begin 再往后放。
- 端侧本地候选的触发器仍未在真机验证：六个真人房 `endpoint_vad` 全 0，硬件 END 从没到过端侧应用层；实际会靠你的 700 ms 无硬件兜底触发。孩子句中停顿 >700 ms 会被截，你已认领这个风险；worker 侧对此无能为力（完整性门只保证收全已冻结的样本）。建议先用批次 2 剩余房跑 1–2 房 `local_receipt_shadow`（只记候选时点、不出声）看触发时刻分布，再接 wire。

## 3. worker 侧合同最小提案（待 codex 确认，未实现）

| 项 | 提案 |
|---|---|
| 房声明 | 签发 metadata 加 `"local_receipt":"v1"`（与 `input_mode` 同处，`opcm_poc_mint_rooms.py --local-receipt v1`）；房文件顶层加 `worker_capabilities:["android_local_receipt_v1"]` 供加载器识别。批次 3 起。 |
| begin | 头加可选 `"local_receipt": true`。缺省/false = 旧行为。 |
| ack | 该代每个 ack 回显 `"local_receipt": "accepted"｜"ignored"`（未声明时无此字段）。`ignored` = 房未签/开关关：端侧**不得**播本地条目，退回旧路径（worker 照播垫句）。这是每输入一次的确认，比房文件更硬。 |
| 放行事件 | 同 topic，`t:"receipt_done"`，头带 input_id/trace_id/session_id/capture_epoch/wake_generation/seq/sent_at_ms，可选 `played_ms`（实际播了多久，只做度量），空 body。身份不匹配 → 只计数 `receipt_done_ignored`，不回 reject；重复 → 首条生效，后续计数；早于 end / 早于 commit 到达 → 记住；代次已 cancel/failed → 忽略，不复活。**永不越过 commit 门**：正文仍要完整性裁决通过才生成。 |
| worker 行为 | accepted 时：该轮 `filler=None`（日志 `filler skipped: device local receipt`）；`start_turn` 把 pcm 管道再包一层 `LocalReceiptGate`（与 `OutputGate::wrap` 同形、同 32 深，背压语义不变）：未放行时扣住所有正文块，LLM/TTS 照跑；放行或到截止即透传。截止 = `end` 到达 + `ORDERED_LOCAL_RECEIPT_MAX_MS`（默认 3000）→ 放行（§2 分歧点）。取消/断开 → 现有路径丢弃。 |
| 开关 | `ORDERED_LOCAL_RECEIPT_ENABLED=1`、`ORDERED_LOCAL_RECEIPT_MAX_MS=3000`，只写 `/root/rust-worker-poc/rust-worker-poc.env`；生产 env 不设 = 全部代码路径不触发。 |
| 观测 | evidence 加 `local_receipt`（accepted/ignored/null）、`receipt_done_ms`、`body_release_ms`、`body_release_reason`（receipt_done｜deadline｜none）；日志 `local receipt gate released reason=… held_ms=…`；沿用 `body first frame published (no filler)` 作正文首帧真值。 |
| 不变项 | 结束候选/投机/TTS 预热/最短垫句逻辑不动（垫句在 accepted 时整段旁路）；`OutputGate`（Android 未订 agent 轨 5 s fail-closed）仍在外层；普通 RTC 房、STOP/EXIT、cancel.ack 顺序、result 线格式不动。 |

## 4. 实施顺序与验收（等川哥点头再动手）

| 步 | 谁 | 内容 | 估时 |
|---|---|---|---|
| 0 | cc（本文） | …7014 证据 + 音频清单 + 合同提案 | 已交 |
| 1 | cc | 分支 `feat/ordered-pcm-input` 实现 §3：`ordered_pcm.rs`（Header/Session/ack/evidence/receipt_done）、`gate.rs`（LocalReceiptGate）、`pipeline.rs`（commit 分支 + start_turn 包装 + 放行传导）、`job.rs`（metadata 字段）、`turn.rs`（CommitInfo 带 local_receipt）；单测：ack 回显两态、receipt_done 早到/重复/错身份/取消后忽略、门放行顺序/截止放行/未开始即已放行透传；`opcm_device_sim.py` 加 `--local-receipt --receipt-delay-ms N` 与 `no_receipt` 场景，断言 receipt_done 前 agent 非零音频帧 = 0、之后 >0；no_receipt 房 end+3 s 后有帧；cancel_mid + 迟到 receipt_done 零帧。home-studio 构建 → 三点 sha → 只换 POC unit（保留 `5b4cc88c…` 回滚）。 | ≈3 h |
| 2 | cc | 铸批次 3（`--local-receipt v1`，含 `worker_capabilities`），投 Studio 受保护目录（文件名再变一次，你改路径）；三条 wav + manifest 投 `~/.p003-oneshot-poc/local-receipt-v1/`。 | 30 min |
| 3 | codex | 先 1–2 房 shadow 看本地候选时点；确认字段后接 wire、构建 >v251、保 exact251 回滚。 | 你定 |
| 4 | 双方 | 两种真人体验各 1 房：一次连说 / 句中短暂停。分开记：说完→本地首声、说完→正文首声、本地结束→正文首声、`body_release_reason`、丢字/回灌/重复承接、underrun。 | |
| ∥ | codex | **早发 begin**（连上可信 agent 即 begin，不等 input_ready）。…7014 证明 end 之后 worker 只要 1.0 s，端侧早 1 s 送音频正文就早 1 s。 | 你定 |

回滚：POC 二进制链 `.bak-5b4cc88c`（本轮前）→ `.bak-dc402a4c` → …；env 删两个键；批次 3 房不签 `local_receipt` 即回旧合同。

## 5. 承接音频（§3B）

来源 = worker 现役全局垫句库 `/opt/voice-agent/fillers-colleague/`（93 条 10 桶，讯飞与正文同音色，文件落盘 2026-08-16 07:01Z，晚于目录旁 `.bak-v7-20260816`）。POC 房 worker 播的就是这套，本地承接用同源文件听感一致。全部 **24000 Hz / mono / PCM16 WAV**，与你要求的规格一致，文件未裁未改。

| 文件 | 文案 | 时长 ms | SHA256（整文件） |
|---|---|---:|---|
| gen_07.wav | 稍等哈。 | 1480 | 5bbce9aa64f80f10839cd4553e413f246996646789eb4e763f8e276388e014c1 |
| ask_08.wav | 我想想哈。 | 1560 | 06df5ed4226a0e1e6362c0b1639990c62933acc5b316b630022db9478a2bbed4 |
| gen_03.wav | 那个，让我捋捋。 | 1720 | 99eb16784537be1ba0846f13abee631570d5425721aec5f66399978e3c0df574 |
| （备选，短） task_08.wav | 稍等。 | 1160 | 3e5563a79d96e553a8319f9714244d4c755bc21a5fe0e434c1a0ae51ea0419dd |

三条都是未识别前不承诺结果的通用句，无 greet/已完成语义。voice/revision 标识：库内 manifest 只有 bucket/text，没有独立 voice id——以上面的目录 + 落盘时间 + sha 为版本锚，不另编号。

**你手里那四条**（task_02/task_03/gen_01/gen_07，2026-08-15 交付）：四个 sha 在现役目录 0 命中，在 `fillers-colleague.bak-v5-20260816`（文件 2026-07-28）4/4 命中，`.bak-v7` 2/4——是 v5 渲染，同名同文案同时长但字节不同，**不要当现役音色用**，以 §5 表为准。

## 6. 川哥已拍板（2026-09-09 20:53 CST）

① 门超时：**放行**（end + 3.0 s，`body_release_reason=deadline`），不取消整代。
② **按 §4 第 1–2 步动手**：cc 立即实现 §3 合同 → 一次 POC 换装 → 铸批次 3 → 投递三条音频。实施完成后本文增量 §8（产物 sha / POC 锚 / 批次 3 文件名 / 音频投递路径 / 模拟器四场景结果）。
③ 承接音频取 §5 表三条。

**codex 可以按 §3 开始接 wire**：字段名以 §3 为准（`local_receipt` / `receipt_done` / ack 回显 `accepted|ignored`），若你要改名请在接 wire 前回一行，两边同时改；不回即按 §3。批次 3 房未到手前用批次 2 剩余房做 shadow（worker 会回 `ignored`，不会开门）。川哥的目标只有一条：响应要快、等待要短——早发 begin 请与本地承接并行推进，不要串行。

## 7. 状态

批次 2 已用 1/12（…7014），剩 11 房，到期 2026-09-11 14:56 CST；旧合同房继续可用于 shadow 与早 begin 试验。生产 worker MainPID 2017631 未动。本文与 …7014 journal 归档未 commit（等 ①）。

## 8. 实施增量（2026-09-09 21:12 CST）——已上 POC，模拟器五场景验过

- **worker**：分支 `feat/ordered-pcm-input` @ `6aaaeac76`（origin 已推，父 `211cbd34b`），产物 sha256 `7bd148faf0c6f032…`（home-studio / Air / 64.90 三点一致），`cargo test` **242/242**（新增 9：ordered_pcm 5 + gate 4），glibc ≤2.39 / GLIBCXX ≤3.4.33 门禁过。**POC unit 已换装** MainPID 2422957（2026-09-09 13:06:22Z = 21:06 CST，换装时 5 received == 5 closed 无在途房）；回滚 `voice-rust-worker.bak-5b4cc88c`（B12 产物）；env 备份 `rust-worker-poc.env.bak-b12`，新增两键 `ORDERED_LOCAL_RECEIPT_ENABLED=1` / `ORDERED_LOCAL_RECEIPT_MAX_MS=3000`（只在 POC env，生产不设 = 全路径不触发）。生产 worker MainPID 2017631（2026-09-06 23:49:55Z）未动，换装后生产 journal `POCTEST0001` 0 命中。
- **合同 = §3 原样，字段名未改**：begin `"local_receipt": true` → 该代每个 ack `"local_receipt": "accepted"|"ignored"`；放行 = 同 topic `"t": "receipt_done"`（头同 begin 身份字段 input_id/trace_id/session_id/capture_epoch/wake_generation/seq，可带 `played_ms`，空 body；任何相位都收，result 之后到达是常态；错身份/未 accepted/已失败只计数不回 reject；重复首条生效）；房级 = 签发 metadata `"local_receipt": "v1"`（worker 三者同时成立才 accepted：env ∧ metadata ∧ begin 声明）。worker 日志锚：`ordered_pcm local receipt v1 … local_receipt_enabled=… meta_local_receipt=…`（job 起）、`filler skipped: device local receipt (body gated until receipt_done/deadline)`、`ordered_pcm receipt_done accepted → body release`、`local receipt gate released reason=receipt_done|deadline|control_gone|receipt_done_before_body held_ms=…`、`body first frame published (no filler)`。evidence 加 `local_receipt / receipt_done_ms / receipt_done_played_ms / receipt_done_ignored / receipt_done_duplicate`（**放行原因与 held_ms 只在门日志**：evidence 在 result 时刻出、早于放行，§3 表里写的 `body_release_*` 以门日志为准）。
- **模拟器五场景**（64.90 自铸房，`s02T_tail1500.wav` 40 ms 实时步进；`docs/oneshot-b6-20260909/b13_sim_results.jsonl` + `poc_journal_b13_sim_rooms_20260909.log.txt` 已归档）：

| 房 | 场景 | ack | worker（相对 commit） | 端侧观测 |
|---|---|---|---|---|
| …959231 | 签房 + 声明 + end 后 1.5 s 发 receipt_done | accepted | 垫句跳过；正文 +713 就绪即被扣；`released reason=receipt_done held_ms=653`；正文首帧 +1398；underrun 0 | receipt_done 前非零回复帧 **0**；首非零帧在 receipt_done 后 156 ms |
| …959280 | 签房 + 声明 + 永不发 receipt_done | accepted | 正文 +279 就绪；`released reason=deadline held_ms=2545`；正文首帧 +2850 | 首非零帧 = end 后 3138 ms（截止 3000 + 传输），不静默不取消 |
| …959298 | 签房 + 声明 + 句中 cancel + 迟到 receipt_done | accepted | result failed/cancelled、零 commit；`receipt_done accepted` 0 条（对照 …959231 为 1） | 回复非零帧 0，不复活 |
| …959248 | **未签房** + 声明 | **ignored** | 旧路径：`filler kept` → gen「嗯。」960 → 正文零空档 | 首非零帧 = result 后 105 ms（垫句） |
| …959338 | 未声明（旧合同） | 无字段 | 旧路径：投机三条件跳垫句，正文首帧 +349 | 与 B12 行为一致 |

- **批次 3 房已投**：12 房 `sn-POCTEST0001-1788959361…372`，48 h，到期 2026-09-11 13:09:21–32Z（21:09 CST）；metadata 签 `local_receipt:"v1"`；文件顶层 `local_receipt:"v1"` + `worker_capabilities:["android_local_receipt_v1"]` + rules 加两条（只在 ack=accepted 时播本地条目；receipt_done 线格式与截止）。Studio `~/.p003-oneshot-poc/opcm_poc_rooms_20260909_android3.json`（600，sha256 `6f8dd8ec5e27d071…`，Studio 侧复核一致）。**加载路径再改一次。** Air/64.90 含 token 副本已删；公开副本 + 注册表入仓。批次 2 剩 11 房（…7015–7024）仍可用于 shadow / 早 begin 试验（未签，worker 恒回 ignored，不会开门）。
- **承接音频已投**：Studio `~/.p003-oneshot-poc/local-receipt-v1/{gen_07,ask_08,gen_03}.wav + manifest.json`（目录 700 / 文件 600；manifest 含文案、时长、24000/1/s16、sha256、来源）；三条 sha 与 §5 表逐一相同（Studio 侧 shasum 复核）。
- **下一房验收看**：端侧只在 `ack.local_receipt=accepted` 后播本地条目；worker `filler skipped: device local receipt` → `local receipt gate released reason=receipt_done`（出现 `deadline` = 放行事件没到端到端，先查端侧发没发、身份字段对不对）→ `held_ms`（门让用户多等的时间，目标 ≈0；>0 说明正文比本地条目先就绪，是早 begin 落地后的常态，届时考虑更短条目）→ `body first frame published (no filler)`；端侧分开记「说完→本地首声 / 本地结束→正文首声 / 丢字 / 回灌」。
- **未变**：结束候选 / 投机 / TTS 预热 / 最短垫句 / OutputGate / 普通 RTC 房 / STOP·EXIT / cancel.ack 顺序 / result 线格式。早发 begin 仍在 codex 手里，与本地承接并行推进。

署名：cc（Claude）| 2026-09-09 21:12 CST
