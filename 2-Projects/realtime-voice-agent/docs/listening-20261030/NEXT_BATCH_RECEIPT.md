# P003 倾听 Worker 下一批开发回执

结论：A、B 批次 Worker 接线、异步 HTTP 客户端、测试及只读评审已完成，交付可评审代码与隔离实测证据。完整 Linux Cargo 508 项通过，另行执行真实 Brain HTTP 联合测试 1 项通过。本轮未部署；C 批次的候选适配和发布验收尚未完成，不代表真机倾听功能已上线。

## 版本与协议

| 项目 | 真值 |
|---|---|
| 工作树 | `/Users/fu-121/.codex/worktrees/p003-listening-worker-20261030` |
| 分支 | `codex/p003-listening-worker-20261030` |
| 开始 HEAD／本批回滚基点 | `4c900d9a239b4cfa580f592502594f21bcba90c3`，开始时 clean |
| 实现、测试、证据提交 | `568dabb12c7d214d05e4be35e44c25c8f9a01287` |
| 普通 Worker 基础 | R18＋style-ark，前批实现 `53727c3fb367f5a4f692a81511d5ac8303eb728a` |
| HTTP 合同 | `4-Assets/contracts/p003-listening-http-v1.json`，version=1，status=`frozen_for_integration` |
| Brain 合同冻结提交 | `1feaeee56ee71923dd2ea76efdef7f57c17f5e00` |
| 合同 SHA256 | `c4df5d49bd7addb09adbf6e06441c21b9b4e5e63e084b58a4f5599c66126e531` |
| fixtures SHA256 | `1c32e52ae65c6d2f0724d033def70e36eb345cc37b9c06f6bbb3a46e7d68ef2d` |
| 联合测试实际 Brain 来源 | `39187a6003f130c7fe73b6bcfb122ae4870c8ca7`；合同仍与冻结版字节一致 |

合同唯一写者仍为 Brain。本树复制冻结版本，没有修改 Brain 工作树或另造协议。Android/control 合同未改。

## 本批实际实现

| 范围 | 行为与失败处理 |
|---|---|
| 身份与控制接线 | 用真实 participant 的 `dev-SN`、room、trace、session 与受信 metadata 绑定；严格解析控制字段、序号、epoch；拒绝伪造及改载荷重放。存在倾听 metadata 却无法构造 adapter 时拒绝启动该 pipeline，不降级普通聊天。 |
| 持久模式与 VAD | 倾听模式独立于 VAD/普通 AgentState；普通叙述只更新字幕和有界会话缓冲，不触发普通 LLM、spec、filler、硬件及搜索。 |
| 进入与双确认 | 异步授权后取消旧 spec/prewarm/paused/deferred 等任务并撤旧音频许可；capture ticket 持有至原生 FFI 完成、排空并 clear，再与 Android `local_ready` 双确认。完成回执使用原 enter RID/seq，重复 enter 不提前 completed。 |
| 音频许可 | TTS、filler、clip、搜索等经统一 playout，按 purpose/epoch/turn 逐帧检查；普通模式新 turn 也撤旧许可。SpeechStart 立即撤反馈许可，SpeechEnd 不复活旧反馈。 |
| 异步 HTTP | 仅允许主 Brain 固定 HTTPS 前缀，禁重定向；service Bearer、worker JWT、grant 三重绑定；响应有界。租约 15 秒、5 秒刷新、请求预算 1 秒，扣除请求与排队时间，迟到响应不能扩权。 |
| 失效处理 | 授权超时、租约失效、进入排空/本地就绪超时均进入 paused 并执行清理，不自动普通 chat。 |
| 摘要与一次反馈 | 独立有界缓冲和摘要 CAS，验证 entry/epoch/hash/coverage；摘要失败退避 5/10/20/30 秒。按钮或高精度直接语音邀请触发一次反馈，结束/失败/打断后回倾听；唱歌场景仅按钮。STT Final 早于 SpeechEnd 时暂存邀请并重验租约。 |
| 调参消费 | session 时限、反馈字数/时长/冷却、摘要间隔/字数、语音反馈开关共七项均有实际消费和变化测试。 |
| 搜索保留 | 进入后结果标记 `requires_explicit_play`，退出不清；可继续接收结果和执行 TTL，不能自动播放，须明确恢复/新搜索。 |
| 能力就绪 | LiveKit 实际注册后的 guard 才上报；要求构建 SHA、可信发布 manifest、策略快照应用确认及本地新鲜度。断连撤销并清除已应用状态；没有生产 manifest 不宣称 ready。 |

主实现由本会话 Codex 亲写；辅助代理仅作只读评审。

## 实测与证据

| 验证 | 实际结果 | 证据 |
|---|---|---|
| Linux `cargo test --offline --locked` | binary 472＋core 29＋runtime 7＝508 通过，0 失败；外部联合测试默认 ignored 1 项 | [完整日志](evidence/full-linux.txt) |
| `cargo test --offline --locked listening_joint_real -- --ignored` | 单独执行上述联合测试，1 通过、0 失败 | [联合日志](evidence/joint-linux.txt) |
| 编译环境 | Linux Rust 1.98.0，edition 2024；非本机 1.70 纯模块替代 | 同上 |
| RTC 可用模拟 | 实际 NativeAudioSource FFI 接收 PCM、逐帧许可、撤权/排空路径 | 完整 Cargo 日志；未连接真机 Room/设备扬声器 |
| HTTP 联合模拟 | Rust 客户端→真实回环 TCP→Brain 实际 Hono 路由、authority 和 SQLite 注册表；验证进入授权、双确认、摘要 CAS、独立反馈、SpeechStart 和撤权后 paused | [Brain bundle 来源及 SHA](evidence/brain-http-bundle-manifest.json) |
| 源码对应 | 19 个源文件/脚本/合同逐字节 SHA，与最终实测版本核对 | [源码清单](evidence/tested-source-manifest.json) |
| 静态差分 | `git diff --check` 通过 | 实现提交差分 |

总计 509 项实际通过。联合测试的凭据、设备、发布 manifest、模型响应均为隔离 fixture；撤权项使用模拟单调时钟推进 15 秒，并非线上墙钟撤权时延取证。Cargo 仍有 dead_code warnings，不宣称零警告。

只读评审发现的 4 项 Important（授权期间查询序号竞争、重复进入提前完成、摘要重试洪泛、语音邀请与摘要竞争）均已修复并定向复核，无 Critical。反向测试与复盘见 [REVIEW_AND_TEST_NOTES.md](REVIEW_AND_TEST_NOTES.md)。部分接线先实现再补测，没有把全批包装成严格测试先行。

构建和测试仅使用专用隔离源码与 target 目录，未重启业务服务、未写穿旧构建缓存，未同步生产环境文件。

## R18 与搜索 R26：候选差分待适配

本批出口仅覆盖普通 R18＋style-ark 基础。只读对照的搜索候选为 `codex/p003-worker-tool-lifecycle-20261021`，当时 HEAD `49bf59282970e224f3b2f3e0730cdbe174e83a4c`。与普通基点 `ef92ee1aa30e6ef869f6270de22173ce51617f30` 的源码差分包括：

`job.rs`、`llm.rs`、`main.rs`、`pipeline.rs`、`search_canary.rs`、`search_control_recovery.rs`、`search_policy.rs`、`search_receipts.rs`、`search_routing.rs`、`search_tasks.rs`、`tts.rs`、`tts_xfyun.rs`、`voice_connect.rs`、`worker.rs`。

本树没有 `search_control_recovery.rs`，不能声称已验证 R26 的控制恢复、重试与重连出口。后续应在候选线分别接入 purpose/epoch/turn 许可和显式播放标记，并独立模拟候选恢复、重试、重连及 TTS 路径；不得整树覆盖或将普通树结果直接算成候选通过。搜索两 SN 和 11 月 2 日 11:19 窗口未改。

## 发布前待验

以下均未勾选为通过，509 项工程测试不能替代这些产品验收：

- 当前 Android APK 的 capability、控制协议和 `local_ready` 实际时序，以及设备实听。
- ≥60 固定产品用例、3×10 分钟真人故事、3 首歌、30 分钟墙钟 session。
- 普通聊天 ≥20 有效对：实质首声增量中位数 ≤100ms、P90 ≤300ms。
- R26 候选独立适配及回归；真实 LiveKit 注册、发布构建 SHA、可信 manifest、Brain ready 闭环取证。
- 新→旧→新发布回滚演练；真实模型内容质量、耗时及异常场景验收。

下一依赖是 Brain/Worker 联合发布门槛核对与当前 Android 能力确认。本轮不自动部署、不打开线上总闸。

## 生产边界与回滚

2026-10-30 09:50:48 CST 已发布后台（发布源 `beafc980`）未覆盖、回滚或重部署；runtime=false、总闸关闭、空名单未改。本轮未修改生产文件/环境/服务、Analytics、Android 包或其他工作树。

本批实现的精确回滚点为父提交 `4c900d9a239b4cfa580f592502594f21bcba90c3`。如需撤销本批开发，应另行审查后在专用开发分支执行 `git revert 568dabb12c7d214d05e4be35e44c25c8f9a01287`；本回执仅记录，不执行回滚。因本轮未部署，没有服务端回滚动作。

更早的 `rollback/p003-listening-worker-20261030` 指向 `ef92ee1aa30e6ef869f6270de22173ce51617f30`，属于首批实现之前的基点，不能与本批回滚点或已发布 Brain 版本混用。

署名：codex（OpenAI）| 2026-10-30 12:00 CST
