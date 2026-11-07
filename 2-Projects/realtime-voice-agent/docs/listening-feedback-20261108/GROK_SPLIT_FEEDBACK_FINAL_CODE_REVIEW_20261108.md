# 固定增量代码复核：50bac0b 相对 3eb21ab

审查人：Grok。只读。未改源码，未部署，未登录主机，未重跑测试。本页只判断这一笔运行增量有没有具体代码阻断。

## 结论

这一笔没有具体代码阻断。Listening 里未完成的「小可」不再进入回声比较；末片只有在拼接结果能 `parse` 成整句白名单时，才用该整句去和近期 TTS 做包含判断。单次完整 final、Normal 态 RecentWake、退出口令仍用原文字做回声比较。

可以在最终 RTC/正式产物门通过、且该产物的源与 `50bac0b28c4f44e169ad574c08682fe509a72a46` 一致之后，做受控单 SN 部署。本页不代替那道门。现在不部署。

## 固定 SHA

- 候选：`50bac0b28c4f44e169ad574c08682fe509a72a46`
- 父提交：`3eb21ab294ebfccbdf03888c0dbc6db21d02f7e9`（`git merge-base --is-ancestor` 成立；`3eb21ab..50bac` 只有这一笔）
- 说明：`fix(p003): compare complete feedback commands in the echo gate`
- 时间：2026-11-08 04:43:19 +0800
- 取证方式：`git show` / `git diff` 固定在这两个提交上。工作区当时干净，HEAD 也是 `50bac0b`，审查没有读取未提交差异。

同一提交还改了 3 个文档（设计说明、计划、`UNIT_EVIDENCE.json`）。运行判断不使用这 3 个文件。三份运行文件的增删是：

| 文件 | 相对 3eb21ab |
|---|---|
| `rust-worker/src/listening_voice.rs` | +8 |
| `rust-worker/src/listening_adapter.rs` | +22 / -2 |
| `rust-worker/src/pipeline.rs` | +19 / -2 |

## 已核

`FeedbackFragments::complete_text`（`listening_voice.rs:229-236`）先走原有 `candidate`。未完成前缀、错场景、过期或错 epoch 的前缀、超过 256 字节的拼接，都返回 `None`。只有 `parse` 成功才返回规范化后的整句。它不改 `pending`。

`voice_final_candidate`（`listening_adapter.rs:253-259`）里的反馈条件从「仍是前缀」改成「`feedback_fragment_complete` 有整句」。`voice_candidate` 仍用前缀判断，interim 持有不变。

`voice_echo_text`（`listening_adapter.rs:238-243`）在候选为假时返回 `None`。候选为真时，有整句就返回整句，否则返回原文。

`try_voice_final`（`pipeline.rs:1485-1496`）把回声比较串从当前尾片改成 `voice_echo_text`。判中后仍走原来的 `discard_echo_voice_context`：已收下的前缀回故事和字幕，当前片不追加，再发空 final。`on_final`、ordered commit、ordered wake-only 都进这个函数。

`voice_command_is_echo` 仍是：播放窗开着，规范化后的近期 TTS 包含被比较串。比较串换成整句之后，「小可」或末字「法」不再单独成为针。

按代码走的四条：

- Listening，单独「小可」或「我讲完了」：`complete_text` 为 `None`，`voice_echo_text` 为 `None`。片进入片段缓冲，不因近期 TTS 里有「小可」被吞。下一片对不上口令时，原有 `push` 会把已收下的前缀放回故事和字幕。
- 四片「小可 / 我讲完了 / 请说说你的看 / 法」：前三片 `complete_text` 为 `None`。末片得到 `小可我讲完了请说说你的看法`。近期 TTS「我是小可，可以说你的看法」不包含这整句，不拦。近期 TTS 含这整句，拦，并且不执行 feedback。
- 一次 final 已经是整句反馈：`feedback_fragment_complete` 返回去标点后的白名单句。`normalize_echo` 再滤一遍后，和旧路径直接比较原文的结果相同。
- Normal RecentWake（「小可」或自然进入）和 Listening 退出（含短退出）：反馈上下文要求 Listening，退出句也不是反馈前缀，所以回声比较串仍是原文。

`now_ms` 是会话锚点已过毫秒，`try_voice_final` 在同一次调用里先读回声再 `tick`。这个顺序在父提交里已经如此。本笔没有把回声判断挪到另一套时钟上。

唱歌场景的 `after_pause` 门仍只在 `push`。未完成的唱歌前缀 `parse` 失败，`complete_text` 仍是 `None`。一次说完的唱歌整句走原文等价的整句比较；执行仍先走 `parse_voice`，不由 `complete_text` 授权。

## 已有日志，不是本页重跑

红日志 `worker-feedback-echo-prefix-red.log`：worker 二进制 `614 passed; 1 failed; 2 ignored`。失败用例是 `listening_split_feedback_partial_is_not_an_echo_command`，断言原文是「a short prefix alone cannot be compared to prior TTS」，位置 `src/listening_adapter.rs:1638`。该日志没有带出后三个集成测试二进制。

绿日志 `worker-feedback-echo-prefix-green.log`：

- worker 二进制 `616 passed; 0 failed; 2 ignored`
- `tests/listening_core.rs` 29
- `tests/listening_runtime.rs` 10
- `tests/listening_voice.rs` 10

合计 665。本页没有重跑，也不把阅读日志写成独立通过证明。

两处 `#[ignore]` 在父提交和 `50bac0b` 都在，都是 Brain HTTP joint harness：`listening_joint_real_brain_http_entry_feedback_and_revocation`，`listening_joint_real_brain_http_voice_singing_uses_negotiated_trigger_and_exit`。绿日志的 “2 ignored” 与这个数量一致；日志正文没有打印名字。

`source-feedback-echo-prefix-green.json` 有 78 个 sha256。我用 `git show 50bac0b:<path>` 的字节逐项计算，78/78 相同。其中三份运行文件是：

- `src/listening_voice.rs` `3bd944a5f892ebc2ded827e989fcfa6c41fed01046240d1e55ab24c6b263dd6f`
- `src/listening_adapter.rs` `80ea3db2bb70fe8975e00fff10298df8892f8c8e5d9ffcb56a0fee66d3e1408a`
- `src/pipeline.rs` `e66be1a03f490ac1bf18cb2dd2f659742fe20a4031e8aca6b8f3a6c7757f4498`

绿日志头里的 `job.rs`、`tts.rs`、`tts_xfyun.rs`、`voice_connect.rs` 四个哈希也落在这份清单里，并与 `50bac0b` 相同。红日志头里这四个哈希与绿日志相同；红树的 `listening_adapter.rs` 没有出现在日志头里，本页不把红树标成另一个完整 SHA。

新增覆盖在源码里是：

- `listening_split_feedback_partial_is_not_an_echo_command`：「小可」「我讲完了」不是 final 候选，收下这两片之后「请说说你的看法」才是。
- `listening_split_feedback_tail_is_echo_candidate_before_any_mutation`：尾片的 `voice_echo_text` 等于 `小可我讲完了请说说你的看法`。
- `listening_fragment_echo_uses_completed_command_not_common_short_parts`：四片只在末片形成整句；近期仅含「小可」和「看法」不拦，含整句拦。

这些测试直接调用 `complete_text` 和 `voice_command_is_echo`，以及适配器候选。它们没有驱动 `Orchestrator` 的播放窗。接线本身在 `try_voice_final` 里是一次函数调用，已读过。

## 未核

- 本页没有重跑红绿测试，也没有打开 `UNIT_EVIDENCE.json` 当通过证明。
- `3eb21ab` 之前的 VAD、原文、字幕、epoch 修复不在本笔差异里。此前说明是 `docs/listening-feedback-20261108/GROK_SPLIT_FEEDBACK_DESIGN_20261108.md`。这里不重开。
- B1 只核对了状态头：`FEEDBACK_V2_RTC_CASE0_STATUS_RETRY.json` 的候选是 `0d863d4b041a9a74f033dd36dfceccbbcc8d726c`，`passed: true`，`production_unchanged: true`，边界写明是真实 SFU/ASR/TTS、合成语音，loopback test-feature 二进制，不是正式二进制，也不是安卓。`FEEDBACK_V2_RTC_CASE0_EVIDENCE.json` 存在。证据正文没有重读。
- DNS、正式构建日志、主机进程、生产二进制，本页都没有核。
- 同 SHA 的 loopback 状态文件已经出现：case 0 与 case 1 记录 `passed: true`，case 2 记录 `passed: false`，错误是字幕「小可」出现两次。`FEEDBACK_CASE2_ASSERTION_ANALYSIS.json` 把这写成两次上游 `stt final: 小可`，并写明不是同片恢复两次。本页没有打开那份 worker log。按本笔代码，两次独立 final 会各走一次持有或释放，两次字幕与两次上游 final 一致；这不能单独证明 case 2 的采集断言。这些状态文件的边界仍写明不是正式二进制。它们不构成正式产物门通过。

## 部署

代码增量可以进入受控单 SN 部署候选。放行条件仍是最终 RTC/正式产物门通过，产物源与 `50bac0b28c4f44e169ad574c08682fe509a72a46` 的 78 文件清单一致，并且生产切换只打这一台 SN。本页只读审查不计入那道门，也不把已有绿日志改写成一次新的测试运行。
