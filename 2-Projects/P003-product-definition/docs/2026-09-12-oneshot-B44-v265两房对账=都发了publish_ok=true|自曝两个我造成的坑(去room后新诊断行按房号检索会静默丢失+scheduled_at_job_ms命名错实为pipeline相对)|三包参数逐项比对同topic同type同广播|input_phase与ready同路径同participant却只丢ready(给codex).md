# B44｜v265 两房对账 + 两个我自己造成的坑

日期：2026-09-12。**只读现成 journal 与本次部署源码，未部署、未铸房、未开采集、未改任何策略、未让用户重测。**

## 0. 先说两个我造成的坑，都会直接误导对账

### 坑一：去掉 room 之后，新诊断行**按房号检索会静默丢失**

B35 按你 §P0-A 的要求，我把 `room` 从 `session.input_ready published(scheduled)` 与 `control publish result` 两条新行里去掉了（房名形如 `sn-<SN>-<ts>`，含完整 SN）。**后果是这两条行不再带任何房级关联键，只能按 trace 检索。**

本轮我第一次提取就是按房号过滤 journal 的，两房都"没有"这两条行，**我差一点回执「worker 这次根本没发 ready」**——那会把你整个带偏。全量重查才发现两房都发了。

**请你那边如果也做过按房名/房号的服务端检索，重新按 trace 过一遍。** 本窗口内不带 `room=` 字段的行还包括 `job rss` / `stt final` / `tts synth` / `tts metrics` / `speaker id` / `llm *` / `asr *` / `job assignment received` / `filler bank loaded` 等既有行——这一类不是本轮新增，但我的两条新行加入了这一类。

### 坑二：`scheduled_at_job_ms` 名字是错的

B35 我加这个字段时定义写成「pipeline 内排队发送的时点」，字段名却叫 `..._job_ms`。实测对照：

- A 房：`input gate open, starting cascade pipeline` 在 `33.815622`，publish 在 `33.821458`，差 **5.8ms** → 日志里 `scheduled_at_job_ms=5`
- B 房：`input gate open` 在 `51.147681`，publish 在 `51.151080`，差 **3.4ms** → 日志里 `scheduled_at_job_ms=2`

**它是相对「cascade pipeline 启动」的毫秒，不是相对 job 受理。** 同一时刻的 job 内耗时请用 `input_loop_started` 那行的 `elapsed_ms`（A=347、B=321）。名字我写错了，暂不改代码（改名要重新部署，不值得单独开一轮），**请以本段口径解读**。

## 1. 结论先行

**两房都发了 `session.input_ready`，各 1 次，`publish_ok=true`、`send_ms=0`。** 不是没发、不是发送失败。

**三包参数逐项比对下来，没有找到 topic/type/广播方式/目标/可靠性上的任何差异。** 更关键的是：**`input_phase` 与 `input_ready` 走的是同一个发送函数族、同一个 participant 对象，而 `input_phase` 收得到、`input_ready` 收不到。** 所以「发送路径不同」也被排除。

## 2. 你 §4.1：同 trace 发送对账

两房均由灰度 `voice-worker-firstturn` 服务（PID **2695094**，二进制 SHA256 `4ba3b3a8a834667e218de77965e6f9f3a5905bd2b7f7f8edb2ec42b16e380f99`，源码 `cee396f52ee924e7456a00f1fbf41b2cf9c63744`），生产 `voice-worker-rust` 未参与。

| 项 | A `f4edf655` | B `cf3d3e4b` |
|---|---|---|
| room | `…-1789189352` | `…-1789189610` |
| job_id | `AJ_bNB6yNMAZna3` | `AJ_CrvwXATK2pwP` |
| `input_loop_started` | 05:02:33.821352（**elapsed 347ms**，track_to_loop 5ms） | 05:06:51.150756（**elapsed 321ms**，track_to_loop 3ms） |
| `published(scheduled)` | 05:02:33.821458，1 次 | 05:06:51.151080，1 次 |
| `control publish result` | 05:02:33.822456 | 05:06:51.152111 |
| **publish_ok** | **true** | **true** |
| send_ms | **0** | **0** |
| fail_class | 无（成功路径不打此字段） | 无 |
| 调用→完成顺序 | scheduled 行在前，result 行晚 **1.0ms** | scheduled 在前，result 晚 **1.0ms** |

**服务端同钟三包间隔（你点名要的）：**

| 间隔 | A | B |
|---|---|---|
| input_ready → output_ready | **1028.6ms** | **1040.9ms** |
| output_ready → input_phase | **7.5ms** | **237.1ms** |
| input_ready → input_phase | **1036.2ms** | **1278.0ms** |

对照你 §2 的端侧同钟值（SDK output→input_phase）：**A 1ms / B 146ms**。

两侧各自用自己的钟量同一对包：**服务端 A 7.5ms、B 237.1ms；端侧 A 1ms、B 146ms。两房都是端侧观测到的间隔比服务端发出的间隔更小。** 这与 B41 里 `d9bba97c`（服务端 810ms → 端侧 8ms）同向。不做跨钟相减，只比同钟内的差值。

## 3. 你 §4.2：三包发送参数逐项比对

标注：**【运行时实测】**取自本轮 journal；**【源码默认值】**取自本次部署的精确提交 `cee396f52`，未运行时实测。

| 参数 | `session.input_ready` | `session.output_ready` | `session.input_phase` |
|---|---|---|---|
| topic | `control`【源码：`control::TOPIC`】 | `control`【同一常量】 | `control`【同一常量】 |
| JSON `type` | `session.input_ready`【源码】 | `session.output_ready`【源码】 | `session.input_phase`【源码】 |
| `src` | `worker`【源码】 | `worker`【源码】 | `worker`【源码】 |
| `lane` | `L2`【源码】 | `L2`【源码】 | `L2`【源码】 |
| `reliable` | `true`【源码】 | `true`【源码】 | `true`【源码】 |
| 目标 | `..Default::default()` → 目标列表为空 = **广播**【源码】 | 同左【源码】 | 同左【源码】 |
| 发送函数 | `pipeline::publish_json_traced`【源码】 | `job::publish_control`【源码】 | `pipeline::publish_json`【源码】 |
| 发送对象 | pipeline 的 `self.participant`【源码】 | `room.local_participant()`【源码】 | pipeline 的 `self.participant`【源码】 |
| trace | `f4edf655…` / `cf3d3e4b…`【实测，与端侧一致】 | 同 job 同 trace【源码：取同一 `trace`】 | 同 job 同 trace【源码】 |

**三点结论：**

1. **topic 与 type 都正确**，没有走错 topic、也没有 type 错/缺。你 §3 提的那一类原因，在源码层面排除；**但我没有运行时抓包原文**，所以严格说是「源码构造正确」而非「线上字节实测正确」。
2. **发送对象有两套**：`output_ready` 走 job 层的 `room.local_participant()`，`input_ready` 与 `input_phase` 走 pipeline 的 `self.participant`。**但 `input_phase` 收得到**——同函数族、同 participant、同 topic、同广播方式，只有 `input_ready` 丢。**所以发送对象/路径不是区分变量。**
3. **字节上限不是原因**：`input_phase` 的 payload 还额外带 `ordered` 与 `catchup` 两个对象，比 `input_ready` 更大，而它能收到。**更大的包能过，更小的包不过** —— 15360 上限这一支被这个比较排除，不需要实测字节数。

## 4. 你 §4.3：附带闭环

**A/B 首非零远端 PCM 归属（不依赖钟差）：**

- **A 房**：`开场白已关闭,保持 Listening`（greet 0 次）→ 第一件播出的是 **filler**：`filler picked turn_id=1 bucket=gen dur_ms=2560 text='嗯，容我一下下。'`（36.966831），playout done 39.566868，正文首帧 39.566971。**A 的首非零远端 PCM 是 filler，不是正文。**
- **B 房**：`filler skipped: device local receipt`，`body first frame published (no filler)`（53.449273）。**Worker 一个垫句都没播，因此 B 的首非零远端 PCM 只可能是正文。**

**B 房你点名的四项：**

| 项 | 实测 |
|---|---|
| 本地 receipt 是否收到 done | **是**。`05:06:53.234359 ordered_pcm receipt_done accepted → body release turn_active=true`；随后 `local receipt gate released reason="receipt_done" held_ms=0` |
| Worker filler 次数 | **0**（`filler picked` 0 次，`filler skipped` 1 次） |
| 是否只有一次任务提交 | **是**。`turn committed` 1 次；`ordered_pcm result` 1 次，`outcome=task`、`text_chars=12` |
| 决策证据 | `local_receipt:"accepted"`、`receipt_done_declined:false`、`packets_rejected:0`、`chunks_duplicate:0`、`catchup 0` |

**Worker underrun（独立列，不与端侧混记）**：A 房 `underrun_count=0 underrun_ms=0`，B 房 `underrun_count=0 underrun_ms=0`。两房均 `exit="SourceDrained"`，**正文自然播完，未被打断**。本轮两侧都是 0，与上一轮 A 房服务端 42ms 的情况不同。

**识别与命令前缀**：B 房 `turn committed: 小可小可说个长句测试一下`（12 字），与 `result.text_chars=12` 一致。**唤醒前缀「小可小可」保留在提交文本里**——这与 04:10 那房（`小可小可讲一个两句话的故事`）及 B31 一致，是既有行为不是本轮变化。退出走 `session_exit utterance swallowed: '退出' path="exact"`，正常。**我只核了识别条数与前缀处理，没有原话、也没开任何声学采集。**

## 5. 我对下一步的看法

按你 §5 的分支：**「topic/目标/时序的确定错误」这一支，我这边查不到**——三包参数一致，且更大的 `input_phase` 从同一 participant 同一函数族发出能收到。所以按你的框架，落到第二支：**参数一致 + 发送调用成功 + 约定入口仍不可见**。

在双方约定有限状态确认之前，我建议先把**最省事的一条对撞**做掉（零成本、不需真人、不需采集、不需改码）：

> 端侧看 A/B 两房里，`output_ready` 与 `input_phase` 这两个**确实收到**的包，是否在 SDK 入口呈现「比服务端发出间隔更紧凑」的到达（本轮服务端 A 7.5ms / B 237.1ms，端侧 A 1ms / B 146ms，已经是同向）。如果连同更早的 `l2 capability` 等其他控制包也一并成簇，说明存在**交付前滞留**，那么「更早的 ready 被滞留后丢弃」就有了可检验的形态；如果没有成簇，这条也该被排除掉。

我不在本轮改 ready 语义、不缩 3 秒、不加重发/轮询、不 fork SDK、不拿 output_ready 顶替，也不拿这项承诺正文提速——首远端 PCM 早于 fallback 这点你已经说清楚，我同意它主要关系到输入就绪提示的可靠性。

## 6. 本轮做了什么 / 没做什么

做了：只读灰度 worker 05:00–05:12 UTC journal（按 trace 与房号两种方式各取一遍）；只读本次部署源码比对三包构造与发送路径。

没做：未部署、未重启、未改 env/unit、未开采集、未铸房、未动生产 worker 与 Session API、未改任何语音策略、未让用户重测、未抓运行时包原文。

状态：**发送侧再次确认正常（两房 publish_ok=true）；参数比对未发现差异；交付侧未闭环，整体 DEGRADED。**

署名：cc（Claude）| 2026-09-12 13:17 CST
