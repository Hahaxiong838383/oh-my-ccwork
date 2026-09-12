# B39｜三 trace 对账回执

日期：2026-09-12。**只读现成 journal，未部署、未铸房、未开采集、未改任何策略。**

## 1. 结论先行

**A 和 B 的 `session.input_ready` 都发了，而且 `publish_ok=true`。** 不是「没发」，也不是「发送失败」——SDK 发送调用成功返回，A `send_ms=0`、B `send_ms=1`。这一层排干净了，这也正是 B32/B35 加这条日志的目的。

**但我的首个根因假设被自己的数据推翻了，先说这个。** 我一开始的判断是「首句房 ready 发得太早，早于设备接收路径就绪」。为此我拉了生产 worker 全量 1793 个样本的 `input_loop_started` 耗时分布：**最小 274 / 中位数 720 / 最大 40645，普通房routinely 落在 274–410ms**，与灰度首句房这 5 个（316 / 322 / 356 / 360 / 407）**完全重叠**。所以「首句房发得早」不是区分变量，这个假设不成立。

**剩下一条干净的夹逼事实**（同一房、同一控制通道、同一 worker 进程）：

- A 房：ready 在 job 内 **360ms** 发出 → **设备未收到**；`output_ready` 在 **1305ms** 发出 → **设备收到**
- B 房：ready 在 **407ms** 发出 → **未收到**；`output_ready` 在 **1315ms** 发出 → **收到**

**设备的下行接收路径在这两个时刻之间才变得可用。** 这是目前证据能支持的最强陈述，我不往前多走一步。

## 2. 你 §4.1 要的逐项（A / B）

三 trace 的归属先答：**A 与 B 都在灰度 `voice-worker-firstturn`（PID 2695094，新二进制 `4ba3b3a8…380f99`）；正锚 presence_return 房在生产 `voice-worker-rust`（PID 2017631，旧二进制）。** 正锚房是普通 RTC 路径，**没有 `control publish result` 是预期**，与你 §4.2 的预判一致。

| 项 | A（`2b69eaff`） | B（`0c3c0937`） |
|---|---|---|
| job_id | `AJ_KTovwkJSrGZB` | `AJ_CsS2XndHiQ6b` |
| unit / agent | voice-worker-firstturn / rust-worker-firstturn | 同左 |
| `input_loop_started` | 04:04:19.470653（elapsed **360ms**，track_to_input_loop **6ms**） | 04:10:05.481706（elapsed **407ms**，track_to_input_loop **0ms**） |
| `published(scheduled)` | 04:04:19.470833，**1 次** | 04:10:05.481748，**1 次** |
| `control publish result` | 04:04:19.471368，**1 次** | 04:10:05.484087，**1 次** |
| **publish_ok** | **true** | **true** |
| fail_class | 无（成功路径不打） | 无 |
| send_ms | **0** | **1** |
| scheduled_at_job_ms | **6** | **0** |
| `input_mode` | ordered_pcm（受信 metadata） | 同左 |
| begin accepted | 19.557，`local_receipt=false`（WAKE_ONLY） | 05.4816，`local_receipt=true` |
| result | `no_task` / `wake_only`，text_chars=4 | `task`，text_chars=13 |
| input phase → rtc | 20.241249，`first_turn_no_task`，catchup 0 | 06.500674，`first_turn_committed`，catchup 0 |
| agent 轨被 Android 订阅 | **20.415530（elapsed 1305ms）** | **06.390295（elapsed 1315ms）** |
| output_ready | 20.415578 | 06.390340 |

时间均为服务端 UTC，去掉日期前缀；换算 CST 减 8 小时得同日 12:04 / 12:10。

**没有「只报 grep 0」**：上表每一行都是实取的存在行，不存在「缺行」；而设备侧的未收到是你那边的观测。

## 3. 与正锚房的对照（关键，含我被推翻的那一步）

正锚房 `sn-…-1789186192`（生产 worker，旧二进制）：

```text
04:09:53.098  received job request
04:09:53.512  worker_room_connected        elapsed 408
04:09:53.805  user_track_subscribed        elapsed 700
04:09:53.820577 input_loop_started         elapsed 715  track_to_input_loop 15
04:09:53.820831 session.input_ready published      ← 旧措辞，无 publish result（旧二进制，预期）
04:09:54.489146 agent_track_subscribed_by_android  elapsed 1384
```

**注意：正锚房的 ready 同样发在 Android 订上 agent 轨之前 668ms，却收到了。** 所以「早于 agent 轨订阅即丢」也不成立——我把这条一起否掉。

**而且正锚只有 n=1。** 我没法拿一个样本说「普通房都收得到」。更要紧的是一个反向可能，请你评估：

> **普通房可能也在丢 ready，只是没人会发现。** 只有首句流程在等 `session.input_ready` 并配了 3 秒兜底；普通 RTC 路径不等它，丢了也无声无息。生产分布里有大量 274–410ms 的样本，若那个区间真的会丢，普通房早就在丢了而无人知晓。

**因此我不认为现有证据足以判定这是「首句路径特有的 bug」。** 它更可能是一个通用的早发竞态，而只有首句流程对它敏感。

## 4. 你 §4.3 要的同 trace 时序对撞

⚠️ 先声明：**我不做跨钟差的墙钟相减**。我试着用两房各自的 server→device 推送事件反推钟差，A 得到 ~308ms、B 得到 ~576ms，**两者不自洽**，说明要么设备钟有漂移、要么设备侧那些时刻不是纯接收时刻。你 §2 的提醒是对的，我按服务端单一钟给值，对齐请你用自己的锚。

服务端单钟下的 A/B 顺序（job 内 elapsed）：

```text
A:  room_connected 174 → user_track_subscribed 353 → input_loop_started 360
    → [ready published + publish_ok=true] 360~368
    → begin accepted 454 → result 1137 → input_phase 1138
    → agent_track_subscribed_by_android 1305 → output_ready 1305

B:  room_connected 140 → user_track_subscribed 405 → begin accepted 406
    → input_loop_started 407 → [ready published + publish_ok=true] 407~414
    → agent_track_subscribed_by_android 1315 → output_ready 1315
    → result 1430 → input_phase 1430
```

**`reliable=true` 与 `publish_ok=true` 都不证明送达**——这条我在 B35 写过，现在它正好是本案的要害：发送侧一切正常，问题在送达。

## 5. 你 §4.4 要的 B 房核对

**filler 与正文归属（这一条不需要钟差即可定性）**：

```text
04:10:06.536842  filler skipped: device local receipt (body gated until receipt_done/deadline)
04:10:07.732795  body first frame published (no filler)   turn_id=1  since_turn_ms=1195
04:10:22.387714  playout metrics turn_id=1 underrun 0 exit="SourceDrained"
```

**B 房 Worker 一个垫句都没播**（本地承接互斥正确生效），所以**该房任何非零远端 PCM 只可能是正文**——不必对钟就能下这个结论。且正文是 `SourceDrained` **自然播完，没有被打断**。

对照 A 房（同样不需对钟）：

```text
04:04:19.464  开场白已关闭,保持 Listening        ← greet 0 次
04:04:22.616989  filler picked turn_id=1 bucket=gen dur_ms=1720 text='那个，让我捋捋。'
04:04:24.364818  filler playout done
04:04:24.414735  body first frame published
```

**A 房 worker 播出的第一件东西是 filler**，正文在其后。所以你 §3 里「该 PCM 可能属于 Worker filler」——**A 房确实是 filler，B 房确实是正文**，两房结论相反，已分别对上。

**12:10:08.250 那个 1 字 ASR 的命运**：

```text
04:10:09.182860  local-audio echo suppressed (opening window): '好'  slot=single-char
```

**是「好」，被开场窗单字规则吞掉，没有 commit，没有起新轮，没有触发任何 filler。** 这与 B31 房②形成对照：那次是 2 字「是的」穿过了文案库精确子串层才起了幽灵轮；这次是 1 字，被无条件吞规则拦住。**本轮没有复现幽灵轮。**

**退出**：`04:10:25.632819 session_exit utterance swallowed: '退出' path="exact"` → job closed 25.829，uptime 20s。`control cancel` 显示 `cancelled=false had_turn=false`（正文已自然播完，无在途轮可取消）。

## 6. 两处与端侧口径不一致

1. **underrun**：你写「A/B Android underrun 均 0」。服务端 **A 房有 1 次**：`underrun_count=1 underrun_ms=42 first_underrun_ms=1518`；**B 房确为 0**。A 这一次只有 42ms，量级上不影响体感，但口径请对一下。
2. 正锚房的采集状态：它落在**生产 `voice-worker-rust`**，该 worker 的 `EOT_SNAPSHOT_DIR` **仍配置且在采集**（B37 我只 unset 了灰度 unit 的）。所以那一房是有 EOT 采集的。**这是本轮之前就存在的状态，我没有改动，也不建议在没有明确决定前去动生产采集配置。**

## 7. 要闭环还缺什么（我的建议，没有动手）

现有证据把问题**缩到了「送达」这一段**，但还差一个能分辨「SFU 丢弃」与「设备侧尚未就绪」的观测。按代价从低到高：

1. **先扩样本，零成本**：把你端侧诊断在**普通 RTC 房**也跑几轮，看 worker 早发（elapsed < 450ms）的普通房是否同样收不到 ready。**如果普通房也丢，这就不是首句特有问题**，结论和修法都会不一样。这一步不需要改任何代码、不需要真人、不需要开采集。
2. **端侧补一个时刻**：Android 记录其**下行数据通道真正可用**的时刻（不是 agent 轨订阅完成）。这个数一旦有了，上面那个 360–1305ms 的夹逼就能直接收敛成一句话。
3. 只有 1、2 都指向「首次下行早于接收就绪」，再谈最小一次性/幂等补发。**我不在本轮改 ready 的首帧语义、不去掉验证、不缩 3 秒兜底、不拿 output_ready 冒充 input_ready**——按你 §4 源码限定执行。

另：去掉兜底 ≠ 正文提速 3 秒，这点你已经说清楚，我同意；而且 A 房正文首帧在 filler 之后，兜底与正文首声之间没有因果。

## 8. 本轮做了什么 / 没做什么

做了：只读两个 worker 的 journal，按 trace/房号提取三房时序；拉生产全量 1793 样本分布做假设检验（并因此否掉自己的假设）。

没做：未部署、未重启、未改 env / unit、未开任何采集、未铸房、未改语音策略、未动生产 worker 与 Session API、未让用户重测。

状态：**发送侧已排干净（publish_ok=true），送达侧未闭环；整体 DEGRADED。** 建议先走 §7 第 1 步扩样本，它可能把问题的性质整个改掉。

署名：cc（Claude）| 2026-09-12 12:25 CST
