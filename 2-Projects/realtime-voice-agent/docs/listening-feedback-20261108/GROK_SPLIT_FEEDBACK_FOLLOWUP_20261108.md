# 跟进：B1 合成 RTC 与 B2 回声比较

审查人：Grok。只读。未改源码，未部署，未跑测试，未登录主机。本页只处理上一份设计说明里的两处，不重开其余历史。

上一份说明把合成 RTC 回放写成了「真机」，并把 ordered 入场写成了 RecentWake。这两处撤回。本页也不评审工作区里已出现的 `50bac0b28c4f44e169ad574c08682fe509a72a46`。那一提交不在本次核验范围。

## B1：这条合成 RTC 关闭运行时疑问，不关闭单测，也不是安卓

关闭的只有这一句：`0d863d4b041a9a74f033dd36dfceccbbcc8d726c` 的 test-feature 二进制，用原反馈 WAV，在真实 SFU / ASR / TTS 上，经过 `on_vad_frame` 的 `SpeechStart`，发出了一次 voice feedback。

不关闭的有：仍然没有调用 `Orchestrator::on_vad_frame` 的单元测试；把倾听 `SpeechStart` 接回 `clear_listening_pending` 的回归，这次集成跑不能当常驻门禁。范围不是安卓，不是生产二进制，不是真人麦克风，也不覆盖 `3eb21ab2` 的回声释放。

证据包 `FEEDBACK_V2_RTC_CASE0_EVIDENCE.json` 的 8 个 base64 成员都对得上包内 SHA-256。其中 5 个又对得上 `FEEDBACK_V2_RTC_CASE0_STATUS_RETRY.json` 的字节数和 SHA-256。包内 `batch-status.json` 与该状态文件的 candidate、二进制、三池前后快照、`passed` 一致。我没有在主机上重算二进制。

| 项 | 证据 |
|---|---|
| 候选 | `0d863d4b041a9a74f033dd36dfceccbbcc8d726c`，二进制 `5352d160b0881b2d2d555105e308f01b1ef77e94537ecc743db279a047c7b027` |
| 结果 | trace `p0-39-a190b68f-66fc-4ca7-8df2-5cb1c19a3cc1`，`passed true`，`rc 0`，`cleanup_error null` |
| 收尾 | `worker_stopped true`，`brain_stopped true`，状态文件 `batch_alive false` |
| 生产三池 | 前后相同：voice `3538554` / `ca41b535…`，search `2446060` / `56f6878f…`，listening `3554867` / `d627dfa9…`，均 `active`、`NRestarts 0` |
| WAV | `prepared.json` 的 `feedback.wav` 为 `c34be346dbcbe74c803e9098b2e76be0b424c9cdb3591a49f7f58198975ea362`，与原失败 WAV 相同 |
| 边界 | 结果自写 `Android: software substitute`，`ASR_TTS: real provider, synthetic WAV input`，`text_provider: deterministic synthetic` |

反馈不是 control 代发。`rtc-probe.py` 的 `speak('feedback')` 把 WAV 的 PCM 推进麦克风轨。本房 control 只有 `session.output_ready`、`session.input_ready`、`session.input_phase`，以及 `listening.proposal` 的 `enter` 与 `exit`。没有 feedback proposal。

`0d863d4b` 的 `pipeline.rs` 里，`listening acoustic speech_start` 只在 `on_vad_frame` 的倾听 `SpeechStart` 分支打印。worker 日志同一 trace 的口令段是：

- 20:34:35.634 `speech_start`（since 13437）
- 20:34:36.338 final「小可」
- 20:34:36.524 `speech_start`（since 14327，距上一条 final 186ms）
- 20:34:37.348 final「我讲完了」
- 20:34:37.715 `speech_start`（since 15518，距上一条 final 367ms）
- 20:34:38.981 final「请说说你的看法」
- 20:34:39.363 TTS「我听到你说，最后一件礼物是一只紫色风筝。…」（52 字）

首条口令 final 到末条 2643ms。三次 final 之间的两次 `SpeechStart` 没有把前缀清掉。末条 final 到 TTS 之间没有新的 `speech_start`。这次 ASR 连接日志写的是 `end_window_ms=150`，三片仍然分开，所以通过不是靠把口令粘成一次 final。

Brain 只有一条 `[listening-content] purpose=feedback chars=52`。探针断言 `one feedback includes immediate synthetic tail marker` 通过，观测体是一次 `purpose=listening_feedback`，`markers.紫色风筝=true`，`synthetic_only=true`。用户字幕在口令窗口是三条空 final，口令原文没有出现在字幕里。恢复聊天的断言在同一结果里为通过：exit 后有普通问答字幕「请告诉我天空为什么是蓝色的」，agent 字幕「这是隔离联调的合成聊天回复。」音频与 metrics 断言也记为通过。metrics 的具体数值我没有重算。

worker 日志里的 `agent_track_subscribed_by_android` 是订阅轨的日志名。结果边界写明 Android 是软件替代。不能把这条叫真机或安卓复现。

## 纠正：合成回放不是真机，入场不是 RecentWake

上一份说明里的 attempt1、baseline 和 `de4c472f` 回放，与这次是同一类合成 RTC。那里写的「真机」应改成「合成 RTC 回放」。`de4c472f` 那次仍然是 `timeout: real feedback audio received`，不能用这次 `0d863d4b` 的通过往回改写。

这次入场也不是 RecentWake。worker 先记录 `input_mode=ordered_pcm`，ordered ASR 收到 final「小可」和「先听我讲个故事」，然后 `ordered_pcm generation complete → chars=9`，`reason=first_turn_listening_command`。`ordered_pcm.rs` 在流结束时提交 `held_finals.join("")`。2+7 字等于日志里的 9。`pipeline.rs` 的 `on_ordered_stream_end` 对这个拼接串调用 `try_voice_final`，命中后才写入 `first_turn_listening_command`。RecentWake 是 Normal 态、RTC 上先唤醒再接自然进入的另一条路径。本房的声学 `speech_start` 从 since 1627 才开始，已经在切到 RTC 之后。

## B2：只比较完整规范化口令，不 OR 尾片

上一份说明同时写了两件不能并存的事。阻断项要求回声只比较规范化后的整句。可证伪测试 6 又要求：近期 TTS 只含「请说说你的看法」时，已收下的前两片留在故事里，尾片不进故事，并且没有 feedback。按现有比较函数，二者冲突。

`3eb21ab2` 的 `voice_command_is_echo` 是：播放窗开着，且规范化后的近期 TTS 包含被比较串。`try_voice_final` 在 `voice_final_candidate` 为真时，拿原始 final 去做这个包含判断。`voice_final_candidate` 含 `feedback_fragment_candidate`，所以未完成的「小可」会进回声门。`discard_echo_voice_context` 只负责门已经判中之后释放先前片段、不把当前片追加进故事。前缀误吞还在。

采用整句比较，放弃尾片 OR。

完成片参与回声判定的唯一条件：这一片本身已是白名单整句，或者它把已收下的片段补成当前场景的那一条白名单整句。被比较串是该整句的规范化形式，也就是去掉空白和 `，。？！、；：,.?!;:` 之后、与 `listening_voice.rs` 三条反馈口令相同的那一串。近期 TTS 必须包含这一整串。单独的严格前缀不进回声门，继续保持；不匹配时按原顺序回故事。

不要再比较原始尾片。白名单没有规定尾片的最小长度。完成片可以是「法」这一个字。包含判断碰到一个字，会把大量正常 TTS 判成回声：真实口令被丢掉，已收下的用户原文被释放并失去授权。这就是新的误吞。给尾片设最短字数会新加一条语义阈值，这次不做。

因此改掉测试 6 的第一句。TTS 只有「请说说你的看法」、或只有「法」，都不得抑制 feedback。尾音回放造成的误触发，留在和「单次 final 必须整句命中」同一精度上，不用后缀表去补。

Codex 先写会失败的测试，再改 echo 谓词。最小断言：

1. 播放窗开着，近期 TTS 含「小可」。用户只说「小可」，下一片不是该口令的延续。「小可」进入故事和字幕，没有 feedback。前缀仍走回声门时，这条失败。
2. 已收下「小可，」「我讲完了。」，尾片「请说说你的看法」，近期 TTS 含整句「小可我讲完了请说说你的看法」。没有 feedback。前两片回故事和字幕，尾片不在。完成时跳过回声门，这条失败。
3. 同样三片，近期 TTS 只有「请说说你的看法」。恰好一次 feedback，口令原文不进故事。实现若 OR 原始尾片，这条失败。这是对旧测试 6 第一句的替换。
4. 四片「小可」「我讲完了」「请说说你的看」「法」。近期 TTS 含「小可」和「法」，不含整句。恰好一次 feedback。比较串若是最后一片，这条失败。
5. 单次 final 已是整句时保持原规则：TTS 含该整句则无 feedback；不含则一次 feedback。

`3eb21ab2` 的释放行为保留：只有整句比较判中的那一次，才释放已收下原文、丢弃当前片、不再授权。

## 不在本次

不宣称安卓复现、生产上线或根治。不重跑单测。不核 `50bac0b2`。等该增量的提交固定后，只看相对 `3eb21ab2` 的 echo 谓词差异。
