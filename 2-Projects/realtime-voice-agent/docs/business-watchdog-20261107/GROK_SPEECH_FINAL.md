# 合成探针令牌：定点最终意见

2026-11-08T00:29+08。只读。未改业务源码，未部署，未重跑探针，未重开 532，未覆盖 `GROK_SPEECH_EVIDENCE_REVIEW.md`。

独立核到的模型 ID：未知。本会话系统提示自称为 Grok 4.7。

## 结论

发布者测试令牌在这条合成探针上已经修掉。正常问答，以及 `begin_timeout` 后转入 RTC 的一轮，可以标隔离通过。全故障没有根治。

仍待处理，并留在既有联合范围内：生产签发、单 SN 发布、真实 Android、ready 3.11–6.74 秒、历史原输入、12 张未匹配签票。这些不构成重审 532 的新代码阻断，也不构成回退 `1f947fe4` 的新反例。

## 六点

1. 同意。6390 ms 只属于第二次缺字幕轮 `RM_UWTNQqRLtTQX`。第一轮 `RM_TZwmiobxXEKi` 的三项计数仍未知，不回填。
2. 同意。隔离通过要同时有客户端 `user_finals`、答案 final 和过门槛 PCM。新两轮都有这三项，并且 exit 0。服务侧 `SourceDrained` 只用来核对关房发生在播完之后。
3. 同意令牌加在发布者。`0ef4e4be` 的 `join_token` 是 `agent: identity=="business-probe-agent"`，旁边两行注释写明这是进房 grant。dev 订阅者没有被写成 true。现网 SFU 版本仍未知。master 行号不当部署证据。通过依据是客户端收到了 final。本轮没有读取现网 SFU 内部分支。
4. 同意用新 A/B 拿掉这条缺字幕红测。负向包探针源码 `cf3d48a1…`，正向包 `ebf0ad84…`。两份清单 68 个键里只有 `src/rtc_business_probe.rs` 不同。正向 blob 与提交 `0ef4e4be7d4f9e9037842d0b4bd68142eed16268` 的探针文件 SHA256 相同。本机 gzip 解压：负向 136341912 字节，SHA256 `de8457f1646c1c399529896817e36203f050face54bae1679867f07bb86e6864`；正向 136342424 字节，SHA256 `ef75442d592ec7d838aa2dcb19bd20136289b3954a08c363980f6c112e7d424b`。负向观察仍是 `user_finals=0`、`answers=[]`、`audible_ms=6390`、exit 101。正向普通轮与 ordered 轮见下表。父提交 `f09884ee` 的探针哈希是 `c445fd3f…`，所以该提交相对父提交还收进了此前工作区里的语音计数；整段 git diff 大于“两行注释加一个条件”。负向正文 `cf3d48a1` 没有留在提交对象里，本轮没有做逐行 diff。
5. 同意 `audible_ms` 只累计平均绝对幅度 `>200` 的帧。普通轮服务侧 turn 2 为 1028 帧 `SourceDrained`，ordered 轮为 816 帧。帧墙钟和 `audible_ms` 的差不写成丢音。ready 为 6741 ms 与 3107 ms。普通轮在订阅前有 `Signal(Timeout("transport timed out"))` 和一次重试，`user_track elapsed_ms=6129`。慢连接仍在。
6. 同意两轮都在播完之后回收。普通轮 16:18:20.830868Z 到 Close 16:18:26.207383Z，差 5.376 秒；ordered 轮 16:19:14.645844Z 到 16:19:19.931229Z，差 5.285 秒。回读都是原房间名 `Gone`，`delete_scope=room_name`，`cas=false`。5 秒仍是探针 metadata。`RTC_AGENT_GRANT_RESULT_2.json` 的 main 仍是 `MainPID=3179125`、`NRestarts=0`，运行脚本仍钉现役 `35f59ecd`。Codex 已说明 cleanup helper 此前装过，三个业务池尚未切换。那是部署边界，不是这轮语音代码的新阻断。

## 两轮正向

时钟是日志 UTC。SN 都是合成 `BJP00326110799999901`，mode `enforce`。

| 轮 | 房间 / SID | 结果 |
|---|---|---|
| 普通 `ordered=0` | `sn-…-1794068275951` / `RM_YAcKnkT9zsf8` | 16:17:55.549Z–16:18:27.927Z，exit 0，`user_finals=2`，答案 1 条，`audible_ms=8110`，`first_audio_ms=13638`，`ready_ms=6741`，Gone |
| ordered `begin_timeout` | `sn-…-1794068333538` / `RM_U5hgUqC5ZvPP` | 16:18:53.029Z–16:19:20.564Z，exit 0，`user_finals=2`，答案 1 条，`audible_ms=6370`，`first_audio_ms=12150`，`ready_ms=3107`，`phase_ms=5610`，Gone |

`RTC_AGENT_GRANT_SERVER_LOG.json` 与 `RTC_AGENT_GRANT_ORDERED_SERVER_LOG.json` 的 attach、Close、`PROBE_OBSERVATION` 与上表同一时刻。它们是过滤摘录，文件哈希不等于测试日志哈希。测试日志哈希分别是 `0f7811636aeab8f86e3687a335ebee56e0cd3ac1a957aeb52bb63b3b52836e9e` 与 `0fce40c768ef64a05707d6cc92ebfc43f092495aa11cb22dddb5bf9b97130e19`。

普通轮客户端答案：“我们抬头看到的天空蓝色，是因为太阳光里的蓝光更容易被大气里的小颗粒散射，所以天空看起来就是蓝色的啦。” ordered 轮：“因为阳光里蓝色光最容易被空气里的小颗粒撞散，洒满整个天空，所以抬头看天就是蓝的啦！” 这是探针收到的 final。

同一条合成 wav 仍把第一段回复打断。普通轮 turn 1 为 25 帧 `Aborted`，ordered 轮为 1 帧 `Aborted`。通过的是随后收到的两类 final 和 turn 2 可听时长。ordered 轮在 16:19:00.150Z 有一条火山 ASR “No audio was received”，随后 16:19:02Z 与 16:19:05Z 两段 `stt final` 到达，该轮 exit 0。这条不另立代码阻断。

## 业务码

`0ef4e4be` 的父提交是 `f09884ee`，`1f947fe4e226382615b147fd8e8bf6031c8d310d` 是其祖先。该提交自身改的是探针和两份证据文件。相对 `1f947fe4`，`main.rs` 只增加 `#[cfg(test)] mod rtc_business_probe;`。抽核 `job.rs`、`pipeline.rs`、`token.rs`、`worker.rs`、`business_watchdog.rs`、`transcript_pub.rs`、`caption_gate.rs`、`business_runtime.rs`、`ordered_pcm.rs`、`room_cleanup.rs`，提交字节与两份包清单相同。旧 exit 101 仍留在 `RTC_AGENT_GRANT_RESULT_2.json` 里。

## 仍打开

- 生产签发和单 SN 发布没有在这轮做。现役二进制仍是探针脚本钉住的 `35f59ecd`。
- 真实 Android 没有新证据。探针客户端不是那个 APK。
- ready 3107 ms 与 6741 ms 仍长。建连性能没有解决。
- `ACTIVE_ROOMS_20261108.json` 在 16:15:59Z 仍是 `RM_D6tdPrWhteMk`、两名参与者。`TARGET_FRESH_20261108.json` 在 16:16:02Z 的过去 3 分钟有 18 个窗口，`mean_amp=0`，turn、playout、`stt final` 都是 0。历史原输入和 12 张未匹配签票没有新解释。
- 测试输出里的 532 filtered out 保持原过滤范围。不因为上面几项重审这 532。
