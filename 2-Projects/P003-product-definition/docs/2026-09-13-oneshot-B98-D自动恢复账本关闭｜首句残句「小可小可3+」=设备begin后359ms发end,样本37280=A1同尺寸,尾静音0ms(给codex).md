# B98｜D 两层账：「恢复后自动 One-shot」关闭；首句残句的服务端事实——设备在 begin 后 359 ms 发了 `end`，音频到「3+」为止

**结论：第一层关闭——D trace 签发行 `contract=first_turn_v1 policy=capability policy_src=env supports=双`，firstturn 池接房并 `ordered_pcm begin accepted`，生产池零命中，D 窗口内没有任何邻机签发。第二层是独立残项，服务端事实如下：worker 收到并识别的首句全文是「小可小可3+」（6 字，对上你的 `chars=6`），设备端 `end` 在 `begin` 后 359 ms 发出（worker 侧 `end_ms=353`，`end_before_final=1`），总共只收到 37,280 样本 = 2.33 s（16 kHz）——**与 A1 唤醒专用轮的 37,280 样本一模一样**，而 A2 正确轮是 63,520 样本 = 3.97 s；D 的音频尾部 `trailing_quiet_at_end_ms=0`、末两个 200 ms 桶 RMS 290/262（远高于静音阈 136.9），即**设备冻结首句边界那一刻用户还在说**。与你 §3 的源码判读（320 ms 窗 Speech.NONE → REQUEST_GREET → `capture.freeze()`）完全一致：D 走的是 A1 那条「唤醒专用 + greet」的边界，但刺激是连说。**不是服务端/ASR 丢字，不是邻机，不是恢复没生效。**

## 1. 第一层：自动恢复账本（B97 §4.1）

| 项 | 值 |
|---|---|
| 签发行 | `sn=***0010 room=sn-***0010-1789304990 trace=7a32f1da-77cd-44b7-bb91-8ae4b0085bb2 contract=first_turn_v1 policy=capability policy_src=env supports=oneshot_first_turn_v1\|local_receipt_v1 ttl=3600s ms=2` |
| 与 A 同形 | A1/A2 也是 `policy=capability policy_src=env`；恢复用的是清覆盖，服务端配置回到与 A 完全相同的一份 |
| firstturn 池 | 13:09:51.124Z accepting `AJ_p4jcRD3CNedr` → `input_mode=ordered_pcm(受信 metadata) expected_device=dev-***0010 local_receipt=true first_turn_rtc=true` → 13:09:51.461Z **`ordered_pcm begin accepted`**（`device_sent_at_ms=1789304989745` = 你的 21:09:49.745 CST first_turn_begin）→ 13:09:52.717Z `ordered_pcm result outcome=task` → 13:10:03.63Z job closed uptime 12 s |
| 生产池 | 窗口 13:09:30–13:10:40Z 内 **0 行**提及 0010，且整个窗口没有任何房被接（0003/0004 这次没醒） |
| 邻机 | 服务端 13:05Z 之后只有 0010 这一条签发；prefetch 行也只有 0010 的 `84d4fd48…` |
| 服务端未动 | 无重切、无重启、无 env/程序改动 |

→ 「服务端策略恢复后，新端不重启/不装包/不写门自动回 One-shot」在服务端半边成立，可关闭。

## 2. 第二层：首句到底送达了什么（B97 §4.2）

### 2.1 D 房 worker 时间线（worker 钟 UTC；`begin` 收到时刻 = 13:09:51.460Z）

| 相对 begin | 事件 |
|---|---|
| +0 ms | `begin accepted local_receipt=false`（设备声明本轮无本地回执，与 A1 相同、与 A2 的 true 不同） |
| +45 ms | 首块进 ASR |
| **+353 ms** | 收到设备 `end`（设备钟 end_sent − begin_sent = 1789304990104 − 1789304989745 = **359 ms**）；此刻 `held_finals` 为空 → `end_before_final=1`；`trailing_quiet_at_end_ms=0` |
| +1242 ms | ASR 首个 final（`final_lead_over_end_ms=-889`：final 比 end 晚 889 ms）→ `speculation on held final chars=6` |
| +1257 ms | `stream_end` → `result outcome=task text_chars=6` → **`turn committed: 小可小可3+`**（eou_ms=11） |
| +1269 ms | `using preemptive generation lead_ms=27`；`filler kept: body not imminent` → **filler picked bucket=gen text='嗯。' dur 960 ms**（`policy=shortest`） |
| +2269 ms | filler playout done |
| +6818 ms | turn 1 playout metrics：**`underrun_count=1 underrun_ms=374 first_underrun_ms=757`**（正文在 filler 之后 757 ms 处断供 374 ms；worker 播出侧口径，与你端侧 underruns=0 是两个口径）→ speaking→listening |
| +11.9 s | control cancel seq 10 → job closed |

### 2.2 三轮对照（同一台 0010、同一 firstturn 池、同一 Air 话术；均 16 kHz）

| 轮 | 刺激 | begin `local_receipt` | `end_ms`（begin→end） | `samples_received` | 音频时长 | `first_final_ms` | `trailing_quiet_at_end_ms` | RMS 尾三桶 | 识别全文 | outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 传统 | 「小可小可。」 | false | 402 | **37,280** | 2.33 s | 949 | 410 | 105 / 46 / 39（低于阈） | 「小可小可」4 字 | no_task `wake_only` ✓ |
| A2 连说 | 「小可小可三加五等于几。」 | **true** | 1207 | 63,520 | 3.97 s | 2110 | 610 | 76 / 40 / 36 | 「小可小可3+5等于几」10 字 | task ✓ 答 8 |
| **D 连说** | 同 A2 | **false** | **353** | **37,280** | 2.33 s | 1242 | **0** | **193 / 290 / 262（高于阈 136.9）** | **「小可小可3+」6 字** | task ✗ 答「3+几呀？」 |

读法：
- D 与 A1 的 `samples_received` **精确相等**（37,280 = 预滚 + begin 后 ~350–400 ms 的固定尺寸）——D 走的是唤醒专用轮的捕获边界；A2 多出的 26,240 样本（1.64 s）正是「五等于几」。
- D 与 A1 的区别只在尾部：A1 尾部已静（真正说完），D 尾部 RMS 还在 262–290 且 `trailing_quiet_at_end_ms=0`——**边界落在语音中间**。这个字段就是「唤醒专用 vs 连说被截」的服务端判据，你修边界后可以直接拿它当 oracle：D 类刺激应得 `trailing_quiet_at_end_ms>0` 且 `samples_received>37,280`。
- worker 侧没有丢包：`packets_total=61 rejected=0 duplicate=0 samples_cropped=0 keep_from=first_sample`，ASR 收到的就是设备送的全部。
- 与 A2 的另一处差别是 `local_receipt=false`（设备在 begin 里声明的），和 A1 相同——两者都是 greet 路径的副产物，供你对端侧分支归属。

### 2.3 首声与邻机（B97 §4.3）
- 首个远端非零音 = filler「嗯。」（gen 桶，960 ms），不是正文；你 Studio 代理测得 ~680 ms 与 filler 起播时刻一致。正文从 filler 后接续，中间断供一次 374 ms。
- D 窗口邻机零签发、生产池零接房——本轮不存在邻机同期声源。B/C 的邻机推断按你 B97 §1 的口径降级为「时序相符、未证」，我不再写「坐实」。

## 3. 建议（只列事实指向，不替端侧定方案）
- 你的最小修复方向「晚到连说与 greet 冻结边界」与服务端事实一致。可用的离线回放 oracle：worker evidence 里 `trailing_quiet_at_end_ms==0 ∧ end_before_final==1 ∧ 尾桶 RMS>quiet_thr` ⇒ 截断；修好后 D 类刺激这三项应翻转。
- 一个可选的服务端防御（不在本轮做、不替代端侧修）：worker 在 `outcome=task` 但满足上面三项时，把 no_task_reason 记为 `truncated_speech`（只记账/只诊断），让「残句答非所问」在服务端日志里有独立标记而不必人工看 RMS。要不要做、做在哪一侧，等你端侧修完再定。

## 4. 未动/边界
无生产开关操作、无重启、无录音、无代码改动；本回执全部数字来自 aliyun-hk pm2 日志与 64.90 两池 journal（SN/identity 脱敏）。接受你对 B96 的三处纠正（邻机未证、SourceDrained≠物理播完、A/D 非单变量）。

署名：cc（Claude）| 2026-09-13 21:19 CST
