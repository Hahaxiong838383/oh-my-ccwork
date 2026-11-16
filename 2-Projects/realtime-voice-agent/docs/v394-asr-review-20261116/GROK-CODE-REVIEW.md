# P003 v394 ASR 独立代码/合同审查

审查身份：Grok 4.7（xAI）。依据是本会话系统指令中的模型自报；本次没有独立的运行时模型指纹接口。不把仓库里其他审查的署名当作本审查身份。

日期：2026-11-16。只读。未启动 PRnas T3，未部署，未改生产、开关、设备、树内源码或共享记忆，未重跑矩阵，未引入新的 LLM 或服务，未下载或外传原始音频与识别正文。

## 结论

ASR 项不能收口，根因也不能唯一判定。R4 少的是问句回合的 final 和回答，房间随后正常关掉，这是一轮核心体验失败，不是卡房或崩溃。

`1cc55436` 的诊断合同本身没有过度工程化，也没有改供应商、判停、队列容量、重连或关房时间。它本应把「未入队 / 已入队未写出 / 已写出但供应商无可用句 / 事件已进通道但业务未收」拆开。这次拆不开，是因为承接 R3/R4 的 `voice-worker-rust`（历史 PID `4183959`）窗口内没有 `asr diagnostic connection summary` / `input summary`。倾听池与搜索池在同一窗口没有这两条 trace。缺计数不是无 final 的根因；没有这些计数之前，任何改判停、换供应商、加追补或补造 final 都过度。

## 材料

- 行为提交 `1cc55436b79cb6ff9617ad4d5421b1d17525f3aa`，父提交 `77c33308082941197897cc3258b1592d0fabccac`。当前分支 HEAD `a64855b98a516a9b2ed25cb67ec30eae060d3e60` 只增加交接文档；`rust-worker` 相对 `1cc55436` 无差异。工作区干净。`job.rs` 不在该提交内。
- 端侧回执：R3 `6cc46771-6552-4910-86a7-8a571de9809b` 有 final 与回答；R4 `ccad0f22-c99b-49fa-8abe-877eca456e74` 无 final、无回答，端侧 `19:36:12.007` 空闲 cancel 后回到 idle。同一问句 WAV。端侧 `input_phase` 在问句播放之前。
- `WORKER-SAFE.json`：窗口 `2026-11-11T11:33:00Z`–`11:36:50Z`，1143 条已脱敏事件，诊断 `stats`/`queue` 条数是 0。房间关联用房间时间戳尾号，不用完整 SN。ASR 日志里的房间值多一个尾部 `}`，哈希因此分裂；`94396931` 与 `396931}` 是 R3，`94396962` 与 `396962}` 是 R4。重叠房 `…6932` 在 R4 问句时段仍有多条 Rtc final，不归 R4。
- 采集当时的现网进程是另一个 PID `795375`，二进制 SHA256 前缀 `d1b1d952c365f964`，诊断截止与 SN 允许列表为空。这只说明 2026-11-16 的进程状态，不能反推 11 月 11 日 PID `4183959` 的二进制。11 月 11 日的证据是：该 PID 的日志里没有诊断汇总。

## 计数作用域

诊断只在 `InputDiagnostic::for_room` 返回 `Some` 时落日志。房间必须是 `sn-<完整 SN>-<时间戳>`，SN 与 `P003_ASR_DIAGNOSTICS_SN_ALLOW` 里某一项 trim 后全等，且墙钟毫秒严格小于 `P003_ASR_DIAGNOSTICS_UNTIL_MS`。尾号、通配、整段房间名都不启用。每个 `spawn_stt` 只读一次环境变量；已经建好的 `Arc` 不再看时钟。关闭时不打汇总。开启时汇总不含 PCM、正文或凭据。

每次 `spawn_stt` 一个 `input_generation`。首轮代次与切到 RTC 后的第二条是两个 generation。同一 generation 里若断线重连，多条连接共用队列计数，每条连接仍有自己的 `request_id`。连接结束时打出的 `queue` 是当时的累计快照，不是该 request 的增量。

| 计数 | 作用域 | 不能这样读 |
|---|---|---|
| `rtc_seen` | 当前发送端上、`rtc_input` 看见的麦克风帧。`stt_pcm_tx` 为 `None` 的帧两边都不计 | 不是已送 ASR |
| `rtc_ignored_before_switch` | 上述帧里，调用时 `input_phase == FirstTurn` 的那部分。正常首轮 generation 上它应等于该代 `rtc_seen`；RTC 代应为 0 | 被忽略的首轮帧不能算问句已送出 |
| `accepted` / `full` / `closed` | 当前代 `try_send` 的结果。有序 PCM 的 `drain_submits` 也走 `try_send`，但不进 `rtc_seen` | `accepted` 不等于供应商收到 |
| 追补 | 直接 `extend` 进 `stt_buf`，不经 `rtc_input`。默认 `ORDERED_RTC_CATCHUP_MS=0` 时不回灌。灌进去之后会混进后续 `accepted` | 不能用 `rtc_seen - accepted` 还原追补 |
| 不足 3200 的 `stt_buf` 尾巴 | 未入队，也没有单独计数。收尾不刷尾 | 最多盲掉 3199 个样本（199.9 ms），解释不了 2628 ms 整句消失 |
| `taken` | 从通道取出、准备写 socket 的样本。空切片在计之前就 `continue`，且不把连接标成已送过音频 | 写失败或取消时可以大于 `written` |
| `written` / `audio_writes` / 首末写时间 / `max_write_ms` | `tx.send` 成功之后。成功写入 sink 仍不等于供应商应用收到 | 非零不等于可懂 |
| `init_written` | init 帧 send 成功。未送过音频就关闭发送端时走 `Unused`：关 socket，不发空 `NegativeSeq` | `Unused` 不是问句失败 |
| `terminator_written` | 已送过音频且输入端关闭后的空尾帧 | 任务被 abort 时通常来不及写 |
| `binary` / `other` | 二进制帧都进 `binary`。非 Full 二进制、文本和 Pong 进 `other` | |
| `responses` 及形状计数 | 只统计 Full 且 JSON 可解析的帧。`definite` 按每个响应帧里的全部 utterances 累加，同一句会重复计。`definite: 1` 这种非布尔不加 `definite` | `definite - final_delivered` 不是丢失数 |
| `empty_definite` | 原文 trim 后为空的 definite 句。这样的句不 `emit` Final，但会占掉 `finals_emitted` 游标 | 标点句若被 canonical 清成空串，可以出现 `definite>0`、`empty_definite=0`、`final_delivered=0` |
| `interim_delivered` / `final_delivered` | 事件通道 `send` 返回 `Ok`。不是客户端收到，也不是业务已经提交 | 切换时丢掉旧 `ev_rx`，已 send 的事件仍留在旧代的 `final_delivered` |
| `event_receiver_closed` | `send` 失败的次数 | |
| `stage` / `outcome` | 正常返回后 `outcome` 才从初始 `cancelled` 改成 `unused` / `last_frame` / `input_done_eof` / `server_closed` / `error`。future 被取消时 Drop 仍打当前 `stage`，`outcome` 保持 `cancelled` | `stage=receive` 且 `outcome=cancelled` 表示还在等供应商时属主没了 |

`asr final received` 打在管道 `recv` 到 `SttEvent::Final` 之时，早于首轮代次、搜索过滤和 `on_final`。因此只要第二条连接把非空 Final 送进了当前事件通道，这条日志就会出现。它不证明字幕已经到端，也不证明供应商没回过空 definite。

热路径：诊断关闭时，`try_send` 仍返回原来的 `Ok` / `Full` / `Closed`，麦循环不新增 `.await`。诊断开启时，入队前会扫样本并短时拿锁，锁不跨 I/O。这次 R3/R4 没有诊断汇总，开启态扫描没有出现在承接进程上。

## 唤醒到 RTC

有序首轮 v1 时，`input_phase` 从 `FirstTurn` 开始。麦克风帧只进 `rtc_seen`/`rtc_ignored` 和可选追补环，然后 `continue`：不进 ASR 队列，不做服务端 VAD。有序 PCM 另走 `on_ordered_packet` → `try_send`，这是唤醒音频进第一条连接的路。

`EndStream` 关掉第一条发送端，并预连第二条。第一条若已经写过音频，会发终止帧并等裁决；没写过则 `Unused`。流正常结束后：

- 纯唤醒词 → `NoTask(WakeOnly)` → `request_phase_switch("first_turn_no_task")`
- 有任务 → `first_turn_committed`
- 一条 final 都没有，且是 v1 → 仍然 `NoTask(NoFinal)` 并切 RTC。这是设计好的「供应商没给唤醒 final」，不是问句失败，也不挡住第二条
- 中断 / 协议失败 → `first_turn_failed:*`

`begin_timeout` 只在首轮仍是 `Idle`、且输入环启动超过 `ordered_begin_timeout_ms`（代码默认 2500 ms，这两间房日志里的代次上限是 `begin_to_end_timeout_ms=12000`）时发生。切换块换上第二条发送端、把 phase 设为 `rtc`，并发布 `session.input_phase`。这个事件只有这一处发布。

`job.rs` 的 `control cancel` 只停正在说的轮。R4 服务端记录 `cancelled=false`、`had_turn=false`，与「还没有回答轮」一致。它不主动停 ASR。随后用户轨断开、job 关闭，流水线收尾会 abort STT。`usable_stt_preconnect` 的 5 秒闲置重建只用于开场那条预连，不用于第二条。

端侧 VAD 和 `voice.audio_level_changed` 不进入服务端 `asr_speech`。服务端 VAD 在首轮被 `continue` 掉，切到 RTC 后才对麦克风帧生效。客户端有 VAD 不能证明第二条连接写出了 PCM。

日志 `input_mode=ordered_pcm … RTC 音频不进识别` 打在 job 开始，描述的是首轮策略，不是切到 RTC 之后的永久丢弃。

## 安全统计已经能钉住的事实

这些事实排除一部分解释，但还不是根因。

R3 与 R4 都在 `voice-worker-rust` PID `4183959`，`nonstream=true`，各有两次 ASR 预连和两次 `outcome=connected`。`end_window_ms=150`，`hotwords=276`，成功轮与失败轮相同。Brain 侧两条 session 都是 `status=ok`，SN 只保留尾号 `03800006`，房间哈希与 worker 侧一致。

R3 服务器时间：

- `19:35:34.324` 切换，`reason=first_turn_no_task`，`catchup_samples=0`，第二条已预连 197 ms
- 两条 `stt final`：一条 `FirstTurn`（4 字），一条 `Rtc`（7 字）
- `19:35:37.356` 问句提交，`eou_ms=696`，`stt_ms=677`，随后有 TTS
- 10 秒 `audio in`：160480 样本，91560 非零，peak 2793，mean_abs 28.84

R4 服务器时间：

- `19:36:03.304` 输入环启动；`19:36:04.457` 第二条预连；`19:36:04.553` 切换，同样是 `first_turn_no_task`，`catchup_samples=0`，预连仅 95 ms
- 第二条连接 `19:36:04.629` 完成，总耗时 171 ms（DNS 0，TCP 1 ms，TLS/WS 169 ms）
- 整个房间只有一条 `stt final` / `asr final received`，phase 是 `FirstTurn`，4 字，紧挨切换之前。没有第二条 `stt final`，没有 `phase=Rtc` 的 `asr final received`，没有问句提交，没有 TTS
- 10 秒 `audio in`（从首帧算到 `19:36:13.305`）：1004 帧，160640 样本，49756 非零，peak 2841，mean_abs 26.26。这是首轮加 RTC 的混合能量，不是问句上行样本，也不是供应商写入量
- `19:36:13.942` 收到端侧 cancel，没有在说的轮；`19:36:14.204` job 关闭

因此可以肯定：

1. R4 问句播放落在 `session.input_phase` 之后。以两端各自的时钟看，切换都早于问句 WAV 开始。不能把整段问句解释成 `rtc_ignored_before_switch`。
2. 唤醒那条 4 字 final 走了既定的 `wake_only → first_turn_no_task`。它不是问句 final，也没有阻止第二条连接建立。
3. 第二条连接已经连上，171 ms，和 R3 第二条的 186 ms 同一量级。不是握手预算把问句吃掉。
4. 管道没有收到第二条 Final。空 definite、未写出、或供应商无句，这三种在现有日志里仍然分不开。`stt final` 只在非空 Final 分支打印；空 definite 的警告不在这次提取器的标记里。R4 房间还有 6 条只带 `room`、没有标记的行，内容未知，不能当成空 definite 证据。
5. 房间关闭了。回执里的 idle 与服务端 job 关闭一致。服务端 cancel 比端侧 `12.007` 晚到 `13.942`，两端时钟不是同一读数；顺序判断用各自时钟，不把差值当成处理延迟。

## 仍开放的分叉

下一次只需要第二条 generation 的现有计数。按这个顺序读，读到能停的一层就停：

1. 没有汇总：进程未编入 `1cc55436`，或 SN/截止不匹配。这是这次已经出现的情况。它不区分音频。
2. `rtc_seen` 有能量，`accepted=full=closed=0`：卡在 3200 样本以下，或发送端当时是 `None`。2628 ms 整句要对上这个分支，RTC 帧本身得几乎没到。
3. `full` 或 `closed` 非零：入队被拒。先看水位，不先扩容。
4. `accepted` 非零而 `written=0`：停在取帧或写 socket 之前。看 `stage`。
5. `written.nonzero` 高，`responses=0` 或只有空形状 / `error_code`：供应商或协议。对照 R3 同字段。不把空结果补成 final。
6. `final_delivered>0` 但没有 `asr final received`：事件通道与管道接收端不一致，优先查代次是否看错。
7. 有 `asr final received` 而端侧无字幕：才查字幕门、回声门和搜索过滤。R4 没有这条日志，所以还没到这一层。

## 最小动作与应拒绝的方案

现在没有可以写进树里的行为修复。缺的是第二条连接的写出/响应计数，不是新的状态机。

拒绝：

- 换 ASR 供应商、改 `end_window`、热词、非流式开关、DDC、队列容量或重连退避
- 为了这一轮打开追补、刷短尾、把首轮忽略帧补送进问句连接
- 用 `definite - final_delivered` 计算丢失，或把空 definite / 无 utterances 合成 final
- 把第一条 `no_final` 或这次的 `wake_only` 当成问句根因
- 把 UI 音量、端侧 VAD、或这 10 秒混合 `audio in` 当成 PCM 已写入供应商
- 把 `…6932` 的 Rtc final 算进 R4
- 重跑 30 轮或倾听/触摸矩阵，新增 LLM、新诊断字段、新服务
- 在计数落在实际承接进程之前改端侧或扩设备

若以后要看到合同计数，那是让实际接这个房间的进程启用已经存在的两个诊断键，并仍按完整 SN 精确匹配。那是运行范围决策，不是本审查要执行的变更，也不是新设计。启用之前，R4 的层仍停在「第二条已连接，管道没收到问句 Final」。

## 核心体验与收口

这一轮问句没有回答，核心对话体验失败了一次。失败后约数秒回到 idle，Launcher 与六项服务在回执里正常，服务端也删了房。诊断代码没有显示它改变了 `try_send` 的结果或送给供应商的载荷；这次承接进程上连诊断汇总都没有，不能把 R4 归因到诊断扫描。

收口标准仍是交接文档里的那条：普通对话不再丢 final，且每次失败都有对应的发送或响应证据。R4 有失败，没有这组证据。房间恢复是另一项，本轮只说明这一次没有卡房。不能把 3 次成功加 1 次未分层的失败收成 ASR 通过。

未跑测试，未编译。行号来自与 `1cc55436` 一致的工作区源码：`asr_diagnostics.rs` 的启用、队列和事件计数，`stt_volc.rs` 的 `run_asr_stream_observed` 与空 final 不补造，`pipeline.rs` 的相位切换、`continue` 和 `asr final received`，`ordered_pcm.rs` 的 `NoTask(NoFinal)` 仍会切 RTC，`job.rs` 的 cancel 与关房。
