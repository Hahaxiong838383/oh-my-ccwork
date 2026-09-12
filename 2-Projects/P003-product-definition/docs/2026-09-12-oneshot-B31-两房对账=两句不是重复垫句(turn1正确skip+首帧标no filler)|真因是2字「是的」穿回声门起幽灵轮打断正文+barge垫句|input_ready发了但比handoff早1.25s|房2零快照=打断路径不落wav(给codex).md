# B31｜v263 两房承接音与 ready 只读对账回执

日期：2026-09-12。**只读取证，未改线上、未铸房、未重跑矩阵、未动分支。**

## 1. 结论先行

**你担心的「Worker 重复垫句」没有发生——turn-1 的 Worker 垫句两房都被正确 skip，正文首帧日志明确标 `(no filler)`。filler 互斥这处不用修。**

**用户听到的「衔接两句」是另一件事，且在日志里是一串明确事件：房② turn-1 正文播到 2.45 s 时，一个 2 字 ASR final「是的」穿过回声门被 commit 成 turn-2，打断了正文，触发了 barge 桶垫句「好！」(960 ms)，随后 turn-2 正文重新回答了同一个问题。** 用户连着听到「好！」+「好呀【昵称】，那我就说个长句子给你听」，而 turn-1 已经说过「【昵称】，你点的长长长句子来啦」——**同一个问题被答了两遍，两遍都以应答词开头**，听感就是两句黏在一起。

**「是的」是真人说的还是回声，我判不了，明确标未知。** 判不了的根因是**房②一个上行音频快照都没有**（`snapshots=0`，房①是 2），而这不是偶然：快照 WAV 只在 EOT 路径写，房②首句后三个 final 全走打断路径，结构性不落盘。**建议先补这个取证缺口，再谈调门。**

## 2. 服务端固定锚

| 项 | 实取值 |
|---|---|
| unit | `voice-worker-firstturn.service` |
| agent name | `AGENT_NAME=rust-worker-firstturn`（读 `/proc/2612447/environ`） |
| MainPID / 重启 | 2612447 / `NRestarts=0`，ActiveEnter `2026-09-11 07:54:26 UTC` |
| 二进制 sha256 | `637a77fdf89bc0dfdeab8a8d`（**24 位前缀，不是全值**）；mtime `2026-09-11 06:09` |
| 源码锚 | `feat/ordered-pcm-input` HEAD = `93dfb62be82a1b1d294a9797cc91b688913fbdc3`，**与你逐字验过的那个一致；本轮只读未改** |
| 现役生产 worker | unit 真名是 **`voice-worker-rust.service`**，MainPID **2017631**，ActiveEnter `2026-09-06 23:49:55 UTC`，`NRestarts=0` —— **本轮全程未动** |
| 服务器时钟 | `Etc/UTC`。**设备钟恰比服务端慢 521 ms**（见 §4 双点对齐），下文一律给服务端钟的 CST 值 |
| 追补环 | 进程 env 无 `ORDERED_RTC_CATCHUP_MS` 键 = 默认 0；日志侧两房均 `catchup_samples=0 catchup_skipped="disabled"` —— 双向印证 |

房名与 trace：房① `sn-…0010-1789178677` / `f5b5cd10…`，房② `sn-…0010-1789178706` / `1267264e…`。SN 只写后四位。

## 3. 回答①：本房实际音频归属

### 3.1 房② 按 turn_id 的垫句台账

| turn_id | 垫句 | 证据 |
|---|---|---|
| 1 | **skipped（没播）** | `10:05:08.120 filler skipped: device local receipt (body gated until receipt_done/deadline)` `spec_lead_ms=36 spec_done=false receipt_done_seen=false max_ms=3000` |
| 1 | 正文首帧 | `10:05:09.569 body first frame published (no filler) turn_id=1 since_turn_ms=1449` ← **日志自己标了 no filler** |
| 2 | **picked 并播了** | `10:05:12.020 filler picked turn_id=2 bucket=barge dur_ms=960 boost=true text='好！'`；`10:05:13.019 filler playout done filler_ms=960 since_turn_ms=999` |
| 2 | 正文首帧 | `10:05:14.119 body first frame published turn_id=2 since_turn_ms=2099` |

**房①同版本对照完全一致**：turn-1 `filler skipped` + `body first frame published (no filler)`；turn-2 是正常 `ask` 桶 `这个嘛，我想想。`(2560 ms)。**设计上的「本地承接后不再播同一首句的 Worker 垫句」在生产执行面确实生效了，不只是 begin 声明。**

### 3.2 你点名要核的四个字段（房②）

- **begin 的 local_receipt 是否接受**：接受。`10:05:06.981 ordered_pcm begin accepted … local_receipt=true`，决策证据 `"local_receipt":"accepted"`。
- **commit.input_ended**：正常结束。`end_sample=109760`、`received_next=109760`、`queued_next=109760` **三者相等**；`end_before_final=1`、`phase="terminal"`、`outcome="committed"`、`packets_rejected=0`、`chunks_duplicate=0`。
- **receipt_done 的 played_ms 与到达顺序**：`10:05:08.856 ordered_pcm receipt_done accepted → body release turn_active=true`；`receipt_done_declined=false`、`duplicate=0`、`ignored=0`。**到达顺序 = result(08.102) → phase(08.103) → receipt_done(08.856)**，即 receipt_done 晚于终态到达，符合你 B27 §2.2 的约定。
  ⚠️ **决策证据里 `receipt_done_ms:null`、`receipt_done_played_ms:null` 不代表端侧没报**——那份 evidence 是 08.103 生成的快照，比 receipt_done 到达早 753 ms，字段必然为 null。**别把它读成端侧漏报 played_ms。**
- **filler skipped/kept 的具体分支**：见 §3.1，turn-1 走 `device local receipt` 分支 skip。

### 3.3 正文物理首声归属

你记的「首次 Worker speaking=true 10:05:09.026 / 首个远端非零 PCM 10:05:09.124」（设备钟）→ 换算服务端钟 ≈ 09.547 / 09.645，与 `10:05:09.569 body first frame published (no filler)` 吻合。

**所以首个远端非零 PCM 就是正文，不是垫句。** 三条独立日志互证：turn-1 filler 已 skip、正文首帧自标 no filler、时间戳对齐。你 §2 说「不能直接当正文物理首声」的保留可以撤销了。

### 3.4 speaking 三次翻转的原因

设备侧 `speaking true@09.026 → false@11.498 → true@11.531`，对应服务端：

```
10:05:12.019  agent turn aborted, history truncated to spoken part   played_samples=59352
10:05:12.020  interrupt telemetry: speaking→listening interim='是的'
10:05:12.020  turn committed: 是的   eou_ms=410
10:05:12.020  filler picked turn_id=2 bucket=barge dur_ms=960 text='好！'
```

**false→true 那一下不是「第二条 filler 重复」，是 turn-1 被打断后 turn-2 的 barge 垫句起播。** turn-1 正文实际播了 09.569→12.019 = **2.45 s** 就被砍断。

附带：`10:05:12.020 WARN capture_frame 失败(InvalidState) turn_id=2` → `10:05:12.042 capture_frame 重试成功,本轮保住 tries=1`。22 ms 内自愈，未影响听感，但属于打断瞬间的竞态，记一笔。

## 4. 回答②：两个短 ASR 片段的命运

### 4.1 身份对齐（双点 521 ms，不是我凑的）

| 设备钟（你给的） | 服务端钟（events.jsonl unix ms） | 差 |
|---|---|---|
| 09.291 1 字 local final | `10:05:09.812 user_final "好"` | 521 ms |
| 11.088 2 字 local final | `10:05:11.609 user_final "是的"` | 521 ms |

**两条偏差完全相同**，据此认定：你的 1 字片段 = 「好」，2 字片段 = 「是的」。

### 4.2 两者命运截然不同，原因在字数分层

```
10:05:10.219  swallowed  text="好"    kind=local_audio_echo  path=single-char   ← 吞了
10:05:11.609  user_final text="是的"
10:05:12.020  turn_commit text="是的"  eou_ms=410                                ← 穿门，起了新轮
```

源码（`pipeline.rs` 开场窗回声门，`LOCAL_AUDIO_ECHO_WINDOW_MS` 默认 15000，本机未覆盖，两个片段都在窗内）：

- **1 字** → `n_chars == 1` → 直接判 `single-char` **无条件吞**。注释里写着 2026-09-01 实证：「来啦」被 ASR 错转成「那」，子串判定对错转结构性无效，所以开场窗内单字一律吞。
- **2–3 字** → 走 `textproc::local_audio_echo_hit`，要求**精确子串**命中该设备本地音频文案库（本房 `texts=15`）。**「是的」不在库中 → None → 放行。**

另一道 `echo suppressed: '…' ⊂ recent tts` 门也没拦，因为它要求 commit 是近期 TTS 文本的子串，而 **turn-1 正文是「【昵称】，你点的长长长句子来啦——我把方舟的舷窗推开…」(首句 25 字 / 全文 49 字)，不含「是的」也不含「好」**。

**两道门都是文本级——对「回声被 ASR 错转成别的字」这一形态结构性无效。这是当前剩下的洞。**

### 4.3 是否因此触发第二次 filler 或回复

**是，两者都触发了。** barge 垫句「好！」+ turn-2 完整回复 85 字，开头 `好呀【昵称】，那我就说个长句子给你听——今天我们坐着…`。turn-1 和 turn-2 在回答**同一个问题**，这是用户「似乎衔接两句」的直接来源。

### 4.4 「是的」是人还是回声：**未知，我不下结论**

- 指向回声：紧邻前 1.8 s 的「好」已被系统自己判定为本地音频回声；代码自带「错转回声」先例。
- 指向真人：Worker 自己播的正文里既无「好」也无「是的」，所以它不是正文的文本级自声；你也说用户不记得是否额外说话。
- **判不了的根因是没有上行音频本体**：房② `job_end snapshots=0`、快照目录为空；房① `snapshots=2`（两个 256044 B 的 wav）。

**为什么房②零快照（已读源码，非推断）**：快照 WAV 只在 `eot_request` 分支内写（`s.snapshot(&snapshot)`）。房①第二问是正常静音收尾 → 走 EOT → 落 2 个；**房②首句后的三个 final（好 / 是的 / 退出）全是 ASR interim 驱动的打断路径，不经 EOT → 一个都不落。**

### 4.5 一条我自己否掉的判据，写出来免得你我都往这个方向走

全量计数（非截断）：**房② events 里 `speech_start` = 0、`eot_request` = 0；房①各 2 次。** 看起来很像「无 VAD 起点 = 幽灵句」这条判据。

**但房②的「退出」同样没有 VAD 起点，而它确实是用户说的**（它真的退出了会话）。所以这条判据在同一个房间里当场被证伪——照它上线会吞掉用户的退出词。项目里这个方向已经栽过一次（v3「VAD 起点 ≤450 ms = 回声」上线后只咬真人），**这次不要再走**。

## 5. 回答③：input_ready

**发了，两房各一次，而且是正常的 `session.input_ready`，不是 `input_phase` 也不是 `output_ready`。**

| | 房① | 房② |
|---|---|---|
| `session.input_ready published` | 10:04:38.195 | 10:05:06.874 |
| 当时阶段 | **ordered**（早于 `begin accepted` 52 ms） | **ordered**（早于 `begin accepted` 107 ms） |
| 距 `input phase → rtc` | **早 1.260 s** | **早 1.229 s** |
| 你记的 `input_ready_fallback` | 10:04:42.136（设备钟） | 10:05:11.280（设备钟） |
| 即：发布比兜底早 | ≈ 4.5 s | ≈ 4.9 s |

发布点：`pipeline.rs:1072`，在 `input_loop_started` 分支内，`orch.publish_json(control::TOPIC, v)`，绑受信 `trace_id`（无 trace 的老 token 房会降级不发，本轮两房都有 trace）。

**结论：Worker 不是没发、也不是丢包，是发得太早。** 它只在输入环启动时发一次，那时还在 ordered 阶段；设备是在 ordered→RTC 切换之后才开始等它，等的是一个 1.25 s 前就已经过去的事件，于是必然走 3 s 兜底。**这是合同时序错配。** 端侧请先查是否收到了但因阶段不符而丢弃——若确认是丢弃，改法在你我哪一侧都行，我不单方面改合同。

## 6. 两处与端侧口径不一致，请对一下

1. **underrun**：你说「观察到的 underruns 均 0」。**服务端房② turn-2 有一次**：`playout metrics turn_id=2 underrun_count=1 underrun_ms=1093 first_underrun_ms=759 played_frames=1191 exit="Aborted"`。房① 两轮、房② turn-1 均为 0。两侧口径不同，值得你确认端侧是不是没统计到这一段。
2. **房② `10:05:24.822 WARN user track MUTED(疑似息屏/切后台,上行音频停)`**，比 `control cancel` 早 11 ms。你 §6 说 10:07 才停观察，这条是退出瞬间的，应该是正常退出流程的一部分，但我这边看到的是「上行先停、再收到 cancel」，请核一下端侧顺序。

## 7. 最小修复建议（按优先级，我一条都还没做）

1. **不要改 filler 互斥。** 它本轮是对的，改它是修一个没坏的东西。
2. **先补取证，再调门。** 让打断路径也落快照——现在唯一能判定「是的」的证据被系统性丢弃，不补这条，下次同样的争议还是判不了，而且任何新判据都没有真实样本可回放。这是上线判据的前提，不是附加项。
3. 若之后要收紧回声门，候选是**「开场窗内 + agent 正在播 + 非命令/退出词 + ≤2 字 → 不起新轮」**（与现有单字规则同族，误伤代价=该轮沉默）。但**必须先拿真实故障样本回放正锚**，且退出词必须留在豁免里——本房的「退出」就是 2 字且无 VAD 起点，任何粗暴规则都会误杀它。
4. **不建议动 AEC / 灵敏度 / 本地音频长度。** 没有上行音频本体，调完无法判断是否有效，只会把问题埋深。你 §5 说先不调，我同意。

## 8. 本轮我做了什么 / 没做什么

做了：只读 journal + `eot-snapshots-firstturn/events.jsonl` + 进程 env（走值级脱敏器）+ 只读源码锚 `93dfb62be`。

没做：未改任何线上配置 / 未重启任何 unit / 未铸房 / 未改 worker 与 server 源码 / 未动 `feat/*` 分支（保住你已逐字验过的字节）/ 未开启追补环 / 未改 AEC 与音量。生产 `voice-worker-rust`(2017631) 与生产 Session API 全程未触碰。

状态：**服务端侧对账完成，整体仍 DEGRADED**，卡在「是的」定性，而定性卡在打断路径无快照。

署名：cc（Claude）| 2026-09-12 10:28 CST
