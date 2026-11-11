# v391 ASR 诊断：固定候选代码评审

署名：Grok（xAI），独立对抗评审。日期：2026-11-11。

候选 `1cc55436b79cb6ff9617ad4d5421b1d17525f3aa`，父提交是基线 `77c33308082941197897cc3258b1592d0fabccac`。行为范围只含这四个源文件：`rust-worker/src/asr_diagnostics.rs`、`stt_volc.rs`、`pipeline.rs`、`main.rs`。同提交的 `docs/v391-asr-diagnostics-20261111/IMPLEMENTATION.md` 不进入行为结论。行号来自该提交的 `git show`，没有读工作区脏文件。

## 结论

这个固定 SHA 在静态阅读和下面这次私有夹具里没有阻断项。未改识别决策、队列容量、`try_send` 的成功/满/关闭语义、init 载荷、分段 3200、definite 规则、重连和取消。诊断默认关闭。打开之后，同一条连接可以把 RTC 入队、websocket sink 写完、一组响应形状、事件通道送达和取消分开。

单 SN 门是房间名 `sn-` 之后第一段的大小写敏感全等，到期是 `spawn_stt` 当时 `now < until`。已经启用的那一代会把汇总留到 Drop，截止之后新的 `spawn_stt` 不再启用。

主 13 的 Linux 基线 746 PASS / 2 ignored、`worker-candidate-final-all.log`、正在进行的实际 ASR 和私有 SFU，都没有当作本次通过。

## 业务行为、性能、生命周期

`main.rs:53` 只声明模块。

`PcmSender` 在诊断关闭时，`try_send` 直接转发内部通道并返回原来的 `Ok`、`Full(样本)` 或 `Closed(样本)`（`asr_diagnostics.rs:70-91`）。调用点仍是 `is_ok()` / `is_err()`（`pipeline.rs:1338-1343`、`1689`）。倾听暂停仍只在 `is_err()` 且倾听开着时发生。麦循环没有新增 `.await`。

诊断关闭时，每个麦帧多一次 `Option` 判断（`pipeline.rs:1244`，`asr_diagnostics.rs:63-64`）。每个音频段在原有 `tx.send` 之前多一次 `Instant::now()`（`stt_volc.rs:334-336`）。没有锁，没有样本扫描，没有额外分配 PCM。

诊断打开时，样本扫描和 `std::sync::Mutex` 都在 `await` 之外。`taken` 在出队后、发送前累加；`written`、`init_written`、`terminator_written`、`audio_sent` 都在对应 `send` 返回成功之后（`stt_volc.rs:297-300`、`322-344`、`370-373`）。发送失败走原来的 `?`，不把该段记入 `written`。空段仍直接跳过，不置 `audio_sent`。未发过音频的预连仍本地关闭、不发 `NegativeSeq`。

任务在 `run_asr_stream_observed` 给 `outcome` 赋值之前被取消时，`Observation` 的 Drop 仍会打出当前 `stage` 和已经写下的计数（`asr_diagnostics.rs:110-112`、`145-152`；`stt_volc.rs:240-250`）。`diagnostic` 为 `None` 时这个 Drop 不打日志。

## 五段计数

RTC 入队在当前 `PcmSender` 上：`try_send` 成功进 `accepted`，`Full` 进 `full`，`Closed` 进 `closed`。麦帧到达进 `rtc_seen`；`input_phase == FirstTurn` 时同时进 `rtc_ignored_before_switch`（`pipeline.rs:1244`、`1309-1332`）。首句代次在入队前 `continue`，所以这些帧留在第一条连接的 ignored 计数里。相位切换丢掉旧发送端，把新发送端标成 `rtc`（`pipeline.rs:1158-1161`）。第二条连接的 `accepted` 从这次切换之后的 `try_send` 开始。

同一条连接上，还没交给 `try_send` 的样本数是 `rtc_seen.samples - rtc_ignored_before_switch.samples - accepted.samples - full.samples - closed.samples`。不足 3200 的尾巴留在 `stt_buf`，这次提交没有加刷尾。`stt_pcm_tx.take()` 之后的麦帧两边都不计。追补回灌直接 `extend` 进 `stt_buf`（`pipeline.rs:1202-1209`），记在第二条的 `accepted` 里，不进第二条的 `rtc_seen`。

sink 写完看该 `request_id` 的 `written`，以及 `init_written`、`audio_writes`、`terminator_written`。`taken` 是 ASR 任务已经从通道取出、尚未确认写完的样本。取消落在 `audio_write` 的 `await` 上时，`stage` 停在 `audio_write`，该段在 `taken` 里，不在 `written` 里，`outcome` 保持 `cancelled`。`written` 表示这次 `Sink::send` 已返回，不表示供应商已经识别。

响应形状能分开的计数：`binary`、`error_code`、`invalid_json`、`missing_result`、`nonobject_result`、`missing_utterances`、`text_present`、`empty_utterances`、`definite`、`empty_definite`、`other`。错误帧写入 `error_code` 后仍走原来的 `bail`。非 Full 二进制帧和文本/Pong 一类 websocket 消息都增加 `other`；只有二进制帧同时增加 `binary`。

这次分不开的形状：具体非 Full 消息类型、原始 flag、`definite` 的非 bool JSON 类型。`definite: 1` 不增加 `definite`。`definite` 按每个响应帧里的全量 utterances 累加，同一句在后续帧里会再计一次。`empty_definite` 看原文 `trim` 后是否为空；只有标点的 `definite: true`（夹具 `"。"`）增加 `definite`，不增加 `empty_definite`。`result: null` 同时增加 `nonobject_result` 和 `missing_utterances`。汇总 JSON 不含转写、PCM 或凭据。

事件送达看 `final_delivered`、`interim_delivered` 和 `event_receiver_closed`（`asr_diagnostics.rs:131-142`）。前两个在 `send` 返回 `Ok` 后增加，最后一个在 `send` 返回错误后增加。`definite` 与 `final_delivered` 的差不是丢失的 final。送达指事件通道接受了这次 `send`。相位切换替换 `stt_ev_rx` 时，已经 send 成功但还没被主循环 `recv` 的事件会随旧接收端丢掉，计数仍留在 `final_delivered`。

取消看 Drop 时的 `outcome` 和 `stage`。`outcome` 只有在 `run_asr_stream_inner` 返回之后才改成 `unused`、`last_frame`、`input_done_eof`、`server_closed` 或 `error`。取消在等待 `send` 期间发生时，`stage` 保持 `event_send` 或 `audio_write`，`final_delivered` 不增加。一次已经结束的失败发送会把 `stage` 设回 `receive`，并用 `event_receiver_closed` 留下失败次数。

同一 `spawn_stt` 里的重连共用一个 `InputDiagnostic`。连接日志里的 queue 是该代次累计值，`written` 属于这一次 `request_id`。没有有序首句的 job 不会走到 `phase("rtc")`，`phase` 字段保持 `ordered_or_initial`；入队和写完计数仍按实际发生的 `try_send` 与 `send` 累计。

## 单 SN 与到期

`enabled_for`（`asr_diagnostics.rs:42-45`）要求房间以 `sn-` 开头，取其后到下一个 `-` 为止的一段，与名单里 trim 后的某一项全等。比较区分大小写。`*`、空项、前缀、多一位、整段 `sn-<SN>-<时间戳>` 都不启用。名单可以写逗号分隔的多个完整 SN；只放一个 SN 时就是这一台。

同提交的房间形态是 `sn-<SN>-<unix秒>`，现有 SN 样例不含连字符。这种形态下第一段就是 SN。夹具里的 `sn-AB-CD-999` 只与名单项 `AB` 匹配，与 `AB-CD` 不匹配。

`for_room` 在每次 `spawn_stt` 读一次环境变量和墙钟（`asr_diagnostics.rs:32-38`，`pipeline.rs:718`）。`now < until`，等于截止时刻时不再启用。时间倒退到纪元之前、截止值无法解析、两个变量缺一个，都返回 `None`。已创建的 `Arc` 不再次看时钟，Drop 时仍打汇总。

## 本次独立测试

私有目录把 `git show` 出来的 `asr_diagnostics.rs` 原样编进夹具。`SttEvent` 只放了同四个变体，供 `emit` 编译。编译器是本机 rustc 1.70.0，依赖钉在 tokio 1.36.0 与 uuid 1.8.0。没有编译 `rust-worker`，没有打开网络套接字，没有用户音频。

`cargo test --offline -- --test-threads=1`：模块内 3 项与独立 3 项全部通过。

- 模块测试覆盖队列 Full/Closed 与样本交还、响应 JSON 不保存夹具词、`enabled_for` 在 `now == until` 时关闭。
- 独立测试覆盖大写 SN `BJP00326110799999901`、小写、前缀、通配、整段房间名、`until=1`、连字符房间的第一段。
- `accepted.samples == 3` 时另一份 `Observation.written.samples` 仍是 0。`Full` 与 `Closed` 把原 `Vec` 交还调用方。
- 8 个夹具响应得到 `missing_result=1`、`nonobject_result=1`、`missing_utterances=2`、`text_present=2`、`empty_utterances=1`、`definite=3`、`empty_definite=0`、`final_delivered=0`。序列化和 Drop 日志都不含夹具正文。
- 通道容量 1 且已占用时，30 ms 超时取消 `emit`。Drop 日志是 `stage=event_send`、`outcome=cancelled`、`final_delivered=0`。
- 接收端已丢时，`event_receiver_closed=1`、`final_delivered=0`、`interim_delivered=0`，完成后 `stage=receive`。
- `diagnostic=None` 的 Drop 没有日志。
- 容量 4 的空通道关闭后再发送，`closed` 增加，`observed_high_water_blocks` 仍是此前真实占用 1。这是 tokio 1.36 的结果。

## 未纳入本次通过

没有运行 `rust-worker` 的测试，包括 `stt_volc.rs` 里本地 websocket 那几项。gzip、`tx.send` 与真实 `Sink` 的先后只来自源码阅读。没有跑 pipeline 麦循环，没有跑主 13 的回归日志，没有接触实际 ASR、私有 SFU、生产配置或用户音频。供应商是否收到字节、主循环是否已经 `recv`，都不在本次执行范围内。
