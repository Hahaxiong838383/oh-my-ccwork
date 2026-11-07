# P003 倾听反馈口令跨 ASR final：根因与最小设计

审查人：Grok。只读。未改源码，未部署，未跑真机，未重跑单元测试。

写文件时工作区干净，HEAD 为 `3eb21ab294ebfccbdf03888c0dbc6db21d02f7e9`（2026-11-08 04:36:52 +0800，`fix(p003): keep accepted story when feedback tail is an echo`）。

用户指定的已审基线是 `61c12793b790480708a3d8fac8f7670c7b2ee68e`。它是当前 HEAD 的祖先。生产运行源码仍是 `de09010304f2a44556bd706c7b810828062b4433`。`de090103..61c12793` 对 `listening_voice.rs` 与 `listening_adapter.rs` 无差异。`5b3fdaac..61c12793` 对这两个文件也无差异。失败发生在进入倾听之后的口令解析。de090 的传输补丁没有改变这两份解析文件。

审查过程中 HEAD 从 `61c12793` 依次变为 `de4c472f`、`0d863d4b`、`3eb21ab2`。下文按这四层分开。写完之后的新提交不在本文范围内。

## 结论

根因成立。已授权 Listening 里，反馈口令必须整句落在同一次 `parse` 输入中。这条 WAV 被 VAD 和 ASR 切成三次 final：「小可」「我讲完了」「请说说你的看法」。三次都进入故事缓冲，不会合成反馈。进入倾听走的是 Normal 态 RecentWake，所以倾听成功，故事期间没有 TTS。

失败判据是没有 feedback 请求、没有反馈 LLM、没有反馈 TTS。反馈命中后只写 `pending_feedback`，本来就不发 `listening.proposal`。日志里唯一的 proposal 是进入。

`de4c472f` 加上了 5 秒绝对前缀保持，但倾听中每次 `SpeechStart` 仍调用 `clear_voice_wake`，把已收下的前缀立刻写回故事。同一条 WAV 的后续真机仍然超时。适配器单测只调用 `Adapter::speech_start`，不会走到那次清除，所以单测可以在管道仍失败时变绿。

`0d863d4b` 把倾听 `SpeechStart` 改成只停播放。按代码路径，它对准了已复现的失败。本文没有运行证明它已经发出 feedback。

`3eb21ab2` 把回声尾片改成：释放已经收下的前缀，尾片不进故事，也不再授权口令。这修的是回声丢字，不是那三次超时。

还不能收口的有两件事。第一，没有测试真正经过 `on_vad_frame(SpeechStart)`。第二，未完成的短前缀「小可」仍是回声候选，播放窗内会被整片吞掉。

## 已核对的运行证据

原始 A/B 使用同一 WAV `c34be346dbcbe74c803e9098b2e76be0b424c9cdb3591a49f7f58198975ea362`。两边 brain 日志都只有 device-session，没有 feedback HTTP。开场白关闭。生产三服务哈希在 batch-status 里未变。日志 SHA 与 `RTC_FEEDBACK_SPLIT_FINDING.json` 一致，本次重新计算过。

| 运行 | worker 日志 SHA-256 | trace | 结果 |
|---|---|---|---|
| attempt1 / 候选 de090 | `fe658905921f3ddc81dbc9701452e6b7ca25f84ea2d7db68a0140445bb2a4b59` | `p0-39-42554d86-7ebd-4b34-8707-dc5b656ef328` | `timeout: real feedback audio received` |
| baseline / 5b3 | `4cea5ab6c391c4757a3452d6fc1f39638f99d51513627da0c357a591faa022ca` | `p0-39-4e602f3c-e8e5-4dc2-9b24-d4746d8ab5ab` | 同上 |
| 后来的 de4c472f 回放 | `0cf56bb6ba74249b0a2429266df72c239d7266f4705e81ff680ab3d8ef9236d0` | `p0-39-bab65dab-74a5-446a-a06e-e7374c35ca97` | 同上。证据写明 `deployed: false`，生产 listening 二进制仍是 `d627dfa9…` |

attempt1 口令段，`listening-rtc-attempt1/worker.log`：

- 19:50:01.444 final「是一只紫色风筝」
- 19:50:04.324 `speech_start`（since 13700）
- 19:50:05.045 final「小可」
- 19:50:05.254 `speech_start`（since 14630，距上一条 final 209ms）
- 19:50:06.140 final「我讲完了」
- 19:50:06.465 `speech_start`（since 15841，距上一条 final 325ms）
- 19:50:07.808 final「请说说你的看法」
- 此后到 19:50:25 断房，没有再出现 `speech_start`

首条口令 final 到末条 2763ms。口令第一声 `speech_start` 到末条 final 3484ms。baseline 对应跨度是 2677ms 与 3507ms。de4c472f 回放是 2913ms 与 3709ms，中间同样各有一次 `speech_start`（215ms、280ms）。末条 final 之后该回放也没有新的 `speech_start`。

故事句同样是一句一次 `speech_start`、一次 final。这是句间静音造成的分段。`stt_volc.rs:80` 的默认 `end_window_ms` 仍是 800。`61c12793..3eb21ab2` 没有改 `stt_volc.rs`。

进入成功的对照：attempt1 在 19:49:51.304 final「小可」、19:49:51.846 final「先听我讲个故事」，随后 ordered commit `chars=9`，`reason=first_turn_listening_command`。这是 Normal 态 RecentWake。de4c472f 回放里唯一的 `listening.proposal` 是 `action=enter`。反馈失败不能用「没有第二条 proposal」来判定。

## 根因锚点（61c12793，与 de090 的倾听解析相同）

`listening_voice.rs`：

- `:14-40` 只有三条反馈整句：`小可我讲完了请说说你的看法`、`小可我说完了请给我反馈`、`小可我唱完了请给我反馈`。
- `:111-112` 非 Enter 必须 `normal == phrase`。
- `:178-182` `possible_prefix` 只挡住同一次 interim 的投机，不跨 final 保存。
- `:145-168` `RecentWake` 只在 Normal 态接自然进入，15 秒。测试明确拒绝用它授权反馈。

`listening_adapter.rs`：

- `:208-221` `voice_final` 在 `parse` 失败时返回 `None`。Listening 态会清掉 RecentWake。
- `:274-295` 反馈命中后只写 `pending_feedback`，trigger 为 `voice_command`。
- `:636-648` `speech_start` 清掉尚未发出的 `pending_feedback`。拼接完成之前不应提前写入它。
- `:665-686` 未命中的 final 进入 `runtime.final_text` 或邀请式反馈。这三片都不是邀请句。

`pipeline.rs`：

- `:2089-2091` `on_final` 在 `try_voice_final` 失败且 `listening_active` 时直接 `final_text`。
- `:1970-1978` 倾听中每个 `SpeechStart` 调用 `clear_listening_pending`，后者调用 `clear_voice_wake`。

三次 final 因此各自成为故事文本。`poll` 不会 `request("feedback")`，也不会起 `TurnKind::ListeningFeedback`。故事期间没有 TTS，是倾听态的原行为。

## 当前提交里应保留的设计

`0d863d4b` 的 `FeedbackFragments`（当前 `listening_voice.rs:186-253`）符合约束：

- 只在已授权、`entry_completed`、phase 为 Listening、授权未过期、没有在途 proposal 或 pending feedback 时保持。见 `feedback_fragment_context`。
- 规范化拼接必须是当前场景那一条反馈口令的严格前缀，并且以「小可」开头。唱歌场景只接受 `singing_only` 那一条。
- 期限是第一片收下时的 `now + 5000`，后续片不刷新。常量在 `listening_voice.rs:186`。5000 盖住已观测的 2763–2913ms，低于 RecentWake 的 15000。`now == deadline` 时整句必须失败并释放。
- 绑定当时的 epoch 与 scene。不一致则释放。
- 唱歌的 `began_after_pause` 在第一片收下时冻结，完成时交给 `voice_utterance_with_pause`。中间 VAD 的 100–325ms 不再改写这个快照。500ms 阈值仍在 `listening_adapter.rs:704-715`，只采样口令开始前的那次 `speech_start`。
- 拼完整句后仍走原来的授权、lease、唱歌停顿、`last_voice` 去重和 `pending_feedback`。不发 proposal。口令原文不进故事。Brain 收到的问题仍是固定句「请对刚才的分享给一次简短反馈。」
- 不匹配、超时、epoch、scene、phase 或授权变化时，原始片段按到达顺序回到故事缓冲并补发字幕。
- `restore_held_text` 允许在 lease 已把 phase 打成 Paused、epoch 已加一之后，按原 entry `request_id` 写回。它不授予 feedback、输出或新 lease。`listening_runtime.rs` 的 `restored_previously_accepted_story_is_bound_to_entry_and_grants_no_permission` 锁了旧 entry 不能写入下一次进入。
- 单片加已保存字节超过 256 时释放，避免无界拼接。

`pipeline.rs:1989-1992` 是对已复现失败的修改：倾听 `SpeechStart` 只调用 `clear_listening_playback_pending`。`Adapter::speech_start` 仍更新停顿位，并清掉尚未发送的 `pending_feedback`，但不再清前缀。口令要到末条 final 才写入 `pending_feedback`。两次真机在末条 final 之后都没有新的 `speech_start`。

`clear_voice_wake`（`listening_adapter.rs:191`）仍会释放前缀。`clear_listening_pending`（`pipeline.rs:1510`）仍调用它。退出、暂停和输入间隙可以继续走它。倾听 `SpeechStart` 不能再接回 `clear_listening_pending`。

`3eb21ab2` 的 `discard_echo_voice_context`（`listening_adapter.rs:199-204`）改为 `flush_feedback_fragments()`。回声分支在丢弃后调用 `flush_listening_voice_captions(None)`，再发空 final（`pipeline.rs:1490-1496`）。尾片本身不进 `final_text`。已收下的前缀回到故事和字幕，并且不能再被尾片授权。这个行为由 `listening_split_feedback_echo_tail_does_not_erase_prior_user_fragments` 描述。我没有运行它。`UNIT_EVIDENCE.json` 里的 `worker-feedback-echo-green.log` 自称 614 通过；`worker-feedback-echo-red.log` 自称 613 通过、1 失败。

`entry_command()` 为空时，`restore_feedback_fragments` 会直接丢掉原文。正常完成进入后，`listening_runtime.rs:203` 会留下 Enter 命令。没有 entry 时不要开始保持。

## 阻断项

1. 没有测试经过 `Orchestrator::on_vad_frame` 的 `SpeechStart`。`listening_split_feedback_real_three_finals_route_once_without_recording_command` 只调用 `Adapter::speech_start`。该函数在 `de4c472f` 里就不清前缀，而真机失败来自管道的 `clear_listening_pending`。所以这条测试在失败的 `de4c472f` 上就会绿。trace `bab65dab` 仍是 `timeout: real feedback audio received`。`0d863d4b` 改了管道调用，没有把该调用放进测试。补上之前，不能把「同 WAV 会发出 feedback」写成已证明。

2. 未完成的严格前缀仍是回声候选。`voice_final_candidate` 对「小可」为真。播放窗内，近期 TTS 只要包含这一片，`pipeline.rs:1490` 就走回声分支并发空 final。61c12793 上，Listening 里的「小可」会进故事。现在故事中的「小可」若落在仍开着的 TTS 回声窗里，会被吞掉，口令也不能从这一片开始拼。已观测的三次失败都没有先行 TTS，这不是那三次超时的原因。它是行为回归。回声比较应只发生在「这一片会把拼接补成整句」或「单次 final 已经是整句」时，比较的是规范化后的整句。单独的严格前缀继续保持，或在不匹配时回故事。

## 可证伪测试

错误实现必须让对应断言失败。第 1 条目前没有这样的测试。

1. 管道分段。已进入故事场景并完成 entry。顺序为 `SpeechStart`、final「小可」、`SpeechStart`、final「我讲完了」、`SpeechStart`、final「请说说你的看法」、`SpeechEnd`、`poll`。调用必须是 `on_vad_frame` 里 `pipeline.rs:1992` 现在那条分支，或该分支唯一调用的函数。期望恰好一次 `pending_feedback`，trigger 为 `voice_command`。故事上下文仍含进入后的原故事，不含这三片。没有新的 `listening.proposal`。把 `SpeechStart` 重新接回 `clear_listening_pending` 时，本测试必须失败。

2. 期限。第一片 `t=0`，第二片 `t=4900`，第三片 `t=5000`。第三片不消费，前两片按原文释放，无 feedback。`t=4999` 的第三片完成且只完成一次。中间片不得推后 deadline。现有纯函数测试已覆盖 `t=5000`。

3. 不匹配立即释放。「小可，」「我讲完了。」「但不要回复」按序进入上下文和字幕，无 feedback。空 final 不能代替这三段正文。

4. 引用、否定、错场景、错 epoch。「“小可」「他说小可」「不要说说你的看法」「请说说你的看法是什么意思」、故事场景下的唱歌三片、epoch 变化后的尾片，都无 feedback，原文可回读。`clear()` 之后的尾片不能单独授权。

5. 唱歌停顿。第一片之前没有 500ms 停顿：三片回故事，无 feedback。第一片之前至少 500ms，中间两段 `SpeechStart` 只隔 100ms：有 feedback，口令原文不在故事里，冻结的 `began_after_pause` 仍是第一片当时的值。中间的 `SpeechStart` 必须与第 1 条是同一条管道分支。

6. 回声。近期 TTS 只含「请说说你的看法」，且已收下「小可，」「我讲完了。」：这两片在上下文和字幕里，尾片不在，无 feedback。`3eb21ab2` 的适配器测试调用了 `discard_echo_voice_context`，还没有断言管道在补发字幕之后才发空 final。近期 TTS 含整句且播放窗开着：整句不进故事，无 feedback。播放窗内 TTS 含「小可」、用户只说「小可」后继续讲故事：「小可」必须进入故事。最后这一条现在会失败，这就是阻断项 2。

7. lease 到期。收下「小可，」后把时钟推过 10000ms，`poll` 后 phase 为 Paused，上下文仍有「小可，」，后续整句尾不能发 feedback，也没有 feedback 输出许可。新 entry 不接受旧 request id 的写回。

8. 普通聊天。Normal 态的「小可」「我讲完了」「请说说你的看法」不保持、不延迟、不发 feedback。单次 final 整句仍一次命中，与 61c12793 的整句测试相同。

## 不确定性

- 没有真人与安卓复现。范围只覆盖这条合成 WAV 的三片切分，以及同一白名单的另外两句。
- `0d863d4b` 与 `3eb21ab2` 没有对应真机。`de4c472f` 的失败不能代替对后两个提交的通过证明。
- 5 秒按这条 WAV 的 2.7–2.9 秒跨度加余量，不是更慢说话的测量。更慢的合法切分会在期限上失败并回故事。
- 保持期间管道会先发空 final，释放时再发原文。反馈上下文读 runtime buffer。若端侧把空 final 当成撤回，要用第 3 条看实际字幕序列。我没有跑端侧。
- `close` 请求体不带原始分段。暂停后写回的文字留在 worker 缓冲里。关房之后没有摘要消费它。
- `worker-feedback-retention-green1.log` 的 `results` 是空数组，不能当通过。green2 与 echo-green 的通过数字来自 JSON 自述，我没有重跑，也没有打开那些日志核对原文。
- 引号被 ASR 去掉、且三片在 5 秒内恰好是白名单词面时，会触发。这与单次 final 整句命中是同一精度边界。不要为此做滑窗或语义判断。

## 明确不在本次

不重复 DNS 审计。不改 ASR `end_window`。不扩大普通聊天。不部署，不跑真机，不动其他工作树。
