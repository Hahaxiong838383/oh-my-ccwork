# 合成问答探针失败：增量只读复核

2026-11-08T00:18+08。只读。未改业务源码，未部署，未操作生产，未派代理，未重跑根因全量审查，未重跑探针。

独立核到的模型 ID：未知。本会话系统提示自称为 Grok 4.7。没有另取服务端模型 ID。不沿用 Grok168，也不沿用历史署名 grok-4.7/high。

## 可质证意见

第二轮计数已经否定“这次探针远端无声”。验收失败是客户端没有收到任何 final 字幕。按今天拉到的 LiveKit master，丢字幕的条件在发布者不是 agent，不在订阅者。现网 SFU 版本未知，所以这仍是待 A/B 的推断，不是已证实的现网根因。不能据此说生产无声，也不能说 normal-short 验收已过。

给主 Codex 的六条：

1. 接受 `RTC_SPEECH_EVIDENCE_RESULT_2.json` 里 `rtc-speech-evidence-enforce-ordered0.json` 的 `PROBE_OBSERVATION`：`user_finals=0`、`answers=[]`、`audible_ms=6390`、`first_audio_ms=11192`。房间 `RM_UWTNQqRLtTQX`。`audible_ms` 的门槛是 12000 个样本，24 kHz 下为 500 ms（工作区 `rtc_business_probe.rs` 182 行，`stats.0/24`）。6390 ≥ 500，可听条款通过。两条字幕计数都是 0，断言失败只剩字幕。
2. 不要把第一轮 `RTC_SPEECH_RESULT_1.json` 的 “normal question did not produce final answer plus audible PCM” 读成无声。那句没有拆开三个计数。第一轮房间是 `RM_TZwmiobxXEKi`，与第二轮不是同一 SID。不要把 0/0/6390 回写到第一轮。
3. master 上的检查对象是发送者。`livekit/livekit` commit `eb9ea3d3634d9fbad02b0516a9f4ddb1f510b9ef`（2026-11-07T09:04:01Z）的 `pkg/rtc/participant.go`：`handleReceivedDataMessage` 在 `DataPacket_Transcription` 分支，`!p.IsAgent()` 则 `shouldForwardData=false`（本轮读到 2618–2624 行）。`IsAgent` 是 kind 为 AGENT 或 `video.agent`（同文件 610–612 行）。Codex 更新稿写的 2454–2460 行已被 master 移走；方向一句“非 agent 不转发”需要收成“发送者不是 agent 则不转发”。探针 `join_token`（`rtc_business_probe.rs` 14–19 行）给 `dev-BJP00326110799999901` 和 `business-probe-agent` 都没有 `video.agent`。要打中这条 master 规则，agent 身份必须加在发布者 `business-probe-agent` 上。只给 dev 订阅者加 `agent=true`，按这段源码不会放行。真实注册令牌在 `token.rs` 33–34 行和 `worker.rs` 120 行有 `agent: true`，探针不走那张 assignment token。
4. 现网 SFU 版本在本轮私有证据里没有。未 SSH。master 不能当成已部署代码。只改测试 token 再 A/B 是对的下一步；本文件不预签通过。
5. `caption final published (deferred)` 不是对端已收到。`pipeline.rs` 2978–2984 行在 `spawn` 之后立刻打 info。`transcript_pub.rs` 95–111 行的 `publish_transcription` 在那个任务里才 await，失败只 `debug!`。第二轮 16:12:45.247Z 与 16:12:45.988Z 的 published_total=1 然后 2、dropped_total=0，只证明本地把两段用户 final 交给了发布任务。
6. 关房发生在播完之后，不是把这一轮掐掉。两轮都是探针自己写入的 `voice_idle.timeout_ms=5000`（`rtc_business_probe.rs` 90 行）。`job.rs` 249 行每 1 秒 `evaluate` 一次，变更才打 decision 日志（264–270 行）。比较是严格 `<`（`business_watchdog.rs` 77–78 行）。

## 两轮时间

时钟都是日志里的 UTC。+8 为 2026-11-08 00:04 与 00:12 左右。

第一轮，二进制阶段 `ace13b39`，日志 SHA256 `da87452c38a4e38f043aa4c3a56268ba8de8449a3149d2f72c5163f436296736`，房间 `sn-BJP00326110799999901-1794067472695` / `RM_TZwmiobxXEKi`，trace `f6f1ce71-6008-4331-a368-6688a3625cdc`。进程起 16:04:32.319Z，止 16:05:00.018Z，exit 101。`RTC_SPEECH_FAILURE_EVIDENCE.json`：

| 时刻 | 事件 |
|---|---|
| 16:04:39.866716Z | `stt final: 请用一句话告诉我` |
| 16:04:42.025874Z | turn 1 committed，随后 16:04:42.666635Z playout `played_frames=0 exit=Aborted` |
| 16:04:42.251186Z | `stt final: 为什么天空是蓝色的` |
| 16:04:42.664260Z | turn 2 committed；同秒 `speaker id: skip(有效语音 0.00s < 1.0s)` |
| 16:04:44.662952Z | turn 2 provider first PCM 561 ms |
| 16:04:44.712493Z | body first frame published，`since_turn_ms=2047` |
| 16:04:52.725298Z | playout `played_frames=804 underrun_count=0 exit=SourceDrained`，`buffered_audio_ms=191` |
| 16:04:58.297062Z | `Close(IdleNoProgress) elapsed_ms=23617` |
| 16:04:59.355018Z | readback `Gone`，`delete_scope=room_name`，`cas=false` |

52.725298Z 到 58.297062Z 是 5.572 秒。正好 5 秒后是 57.725298Z，日志晚 0.572 秒，落在 1 秒采样窗内。804 帧的墙钟约 8.013 秒（44.712493Z→52.725298Z），与 10 ms 帧的 8.04 秒只差约 27 ms。帧长是对齐出来的，本轮没有另读 playout 帧定义。

第二轮，Codex 更新稿称未压缩二进制 SHA256 `de8457f1646c1c399529896817e36203f050face54bae1679867f07bb86e6864`。本机只有 gzip `rtc-probe-de8457f1.gz`，SHA256 `76fa7762e7a8e5809e4a48ea46b9c0e7c948d3c1b16f56ff68d5107a1aa0f3ba`，36987932 字节。gzip 摘要不是二进制摘要，未解压复核。日志 SHA256 `d8def71b517d3329082a35ff469b5ea822ebdabf45cbed0d8452622b5ff4ce42`。房间 `sn-BJP00326110799999901-1794067955649` / `RM_UWTNQqRLtTQX`。进程起 16:12:35.228876Z，止 16:13:03.858214Z，exit 101。`RTC_SPEECH_EVIDENCE_FAILURE_LOG.json`：

| 时刻 | 事件 |
|---|---|
| 16:12:43.271516Z | `stt final: 请用一句话告诉我` |
| 16:12:45.247202Z | `caption final published (deferred)` segments=1 published_total=1 |
| 16:12:45.570021Z | `stt final: 为什么天空是蓝色的` |
| 16:12:45.986596Z | turn 1 `played_frames=0 exit=Aborted` |
| 16:12:45.986734Z | turn 2 committed；`有效语音 0.00s` |
| 16:12:45.988260Z | 第二段 caption，published_total=2 dropped_total=0 |
| 16:12:48.763898Z | turn 2 first PCM 600 ms |
| 16:12:48.786010Z | body first frame，`since_turn_ms=2798` |
| 16:12:57.540465Z | `played_frames=876 underrun_count=0 exit=SourceDrained`，`buffered_audio_ms=198` |
| 16:13:02.856467Z | `Close(IdleNoProgress) elapsed_ms=25148` |
| 16:13:03.507229Z | readback Gone，同样 `cas=false` |

57.540465Z 加 5 秒是 16:13:02.540465Z，日志晚 0.316 秒。876 帧对 48.786010Z→57.540465Z 的 8.754 秒，与 8.76 秒只差约 6 ms。客户端 `first_audio_ms=11192` 若对准 48.763898Z，则探针内部 `started` 约在 16:12:37.572Z，watchdog attach 在 16:12:37.720Z，相差约 148 ms。这是对齐，不是第二套时钟。

`probe_results` 两轮都是空数组：`ensure` 在 `PROBE_RESULT` 之前失败（当前源码 182 行与 200 行）。第二轮的 `PROBE_OBSERVATION` 在 `ensure` 之前，所以失败日志里仍有计数。

## 源码与哈希

- HEAD `f09884ee818437f54bd38b33d15caa6d35100223`，1f947fe4 是其祖先。`git status` 只有 `rtc_business_probe.rs` 为修改。工作区该文件 SHA256 `cf3d48a15ab08b67fd698d45dbd081146956904b021557f56067daee62572f38`，与 `source-rtc-probe-package-speech-evidence.json` 的 `src/rtc_business_probe.rs` 相同。
- 第一轮包 `source-rtc-probe-package-speech.json` 的探针源码是 `6522832ddd947b57d756c0b05f386be71919c1e906e6bf195b80bb240614f897`，对应错误文案还是未拆计数的那句。二进制登记 `ace13b397b6b278eff953f7abff2aa1881fc7e99b43cfd85cdac73a343490bf0`（`RTC_PROBE_SPEECH_STAGED.json`）。
- `job.rs`、`pipeline.rs`、`business_watchdog.rs`、`business_runtime.rs`、`transcript_pub.rs`、`caption_gate.rs` 在 `1f947fe4` 与 HEAD 字节相同。包清单中的 `job.rs` 为 `471756738f09525358e1b7803f2c25f7102bdf55b6b2fa3f6700d2b1bbffc299`，与这次重算的前缀一致。语音探针没有另改这些业务文件。
- 现役哈希仍是探针脚本钉死的 `35f59ecde2ce892f0c865ae90880747a00f782cccbffe39abe5dc3234e464971`。`RTC_SPEECH_RESULT_1.json` 的 `main` 为 `MainPID=3179125`、`NRestarts=0`。本轮没有新的进程取证。

客户端可听样本只统计 identity 为 `business-probe-agent` 的远端音轨，且帧均值绝对值 `>200`（`rtc_business_probe.rs` 125–135 行）。所以 6390 ms 不是用户麦克风回环。它短于约 8.76 秒的 876 帧：均值不超过 200 的帧不计，drain 时还有 `buffered_audio_ms=198`。不能写成客户端听完了每一帧，但足够否定“均值过门槛的可听时长为 0”。

`speaker id: skip(有效语音 0.00s < 1.0s)` 是声纹环快照长度除以采样率（`speaker_id.rs` 179–184 行）。环在均值绝对值 `<250` 时不收入（75–77 行，`min_amp` 250 在 71 行）。它与 ASR final 同时出现，不能读成输入数字静音。开场 `native audio stream queue overflow` 在 `input_loop_started` 之前；两轮之后仍各有两段 `stt final`。

turn 1 的 0 帧 `Aborted` 与 turn 2 的 commit 在同一秒。播出来的是 turn 2。第一轮还有 `llm consumer gone (interrupted)`（16:04:42.974193Z）。这是同一条合成 wav 被 ASR 切成两段后，第二段打断第一轮回复。fixture 路径与 SHA256 `9ea46b2c…0b03` 写在探针 46–47 行。两轮错误都不是 `fixture hash mismatch`，所以哈希门已过。wav 时长本轮未在 Worker 上复读。

用户字幕走 caption gate：非空 final 先缓冲（`pipeline.rs` 1968–1982 行），commit 后 `publish_deferred_batch`（2978–2984 行）。agent 句 final 在 `PlayedOut` 时 `tr_finish_turn`（2878–2882 行、2834–2850 行），这条没有对应的 info 行。第二轮提取日志里没有 agent 字幕发布行。`answers=0` 与用户字幕为 0 是同一条发布者令牌假设能同时解释的；不能单独证明 LLM 没有生成文本。TTS 已发出请求并返回 PCM，正文文本本身不在这份过滤日志里，确切答句未知。

## 证据界限

已证实：

- 两轮都是合成 SN `BJP00326110799999901`、`ordered=0`、`enforce`、exit 101。服务侧各有两段 ASR final、turn 2 的 TTS 首包 PCM、SourceDrained、underrun 0。
- 第二轮独立客户端收到该 agent 音轨上 6390 ms 过门槛样本，同时 final 字幕计数为 0。
- 两轮关房都在 SourceDrained 之后约 5.3–5.6 秒，与签发的 5000 ms 加 1 秒采样相符。回读是原房间名 Gone，`cas=false`。
- 探针令牌没有 `video.agent`。今天的 LiveKit master `eb9ea3d` 对非 agent 发送者的 transcription 包不转发。
- 这次失败不改变 Grok168 对 `1f947fe4` 三条调用点“无阻断、且不得当成真实 RTC 已过”的范围。本轮不重开那份审查。

推断：

- 第二轮字幕为 0 是因为发布者令牌不是 agent，SFU 丢了 transcription，而音频轨不受该分支影响。要等现网 SFU 版本对齐之后，用只改发布者测试令牌的 A/B 才能证实。
- 第一轮同样不是无声。只有服务侧 PCM 与 804 帧，没有客户端 `audible_ms`。
- 10 ms 帧长，以及 `first_audio_ms` 与 provider first PCM 相差约 148 ms。

未知：

- 现网 SFU 的版本和 `participant.go` 是否含 2618–2624 行这段。
- 第一轮的 `user_finals`、`answers`、`audible_ms`。第一轮提取器的键不含 `caption`，所以“第一轮有没有 caption final published”也未知。
- 第二轮 agent 答句原文，以及 `publish_transcription` 的 SDK 返回值。
- 生产房间 `RM_D6tdPrWhteMk` 此刻有没有声音。本探针不是那个房间。
- 安卓当前 APK 是否收得到字幕。探针客户端不是那个 APK。
- 本轮执行模型的服务端 ID。

## 部署前阻断

本轮新证据取消的是“这次合成探针证明生产或该测试房无声”。它不取消下面这些：

- normal-short 断言仍是红的。在发布者令牌 A/B 给出非空 `user_finals` 与 `answers` 之前，不能把这条当验收通过。若 A/B 后字幕仍为 0，再查 SDK 收包，不要先改业务发布逻辑。
- 候选业务码 `1f947fe4` 不是现役 `35f59ecd` / PID 3179125。探针脚本还在断言现役哈希未被换掉。
- 5 秒是探针 metadata，不是已经上线的产品 idle。
- Brain 签发、安卓真机、旧房清理纪律，本轮没有新证据。沿用 `P003_02000053_GROK_JOINT_RECONFIRM_20261107.md` 与 `GROK_RECONFIRM_FINAL.md`，不在这里重审。

没有需要回退 `1f947fe4` 业务码的新反例。分歧只有令牌假设的作用对象：发布者，不是订阅者。
