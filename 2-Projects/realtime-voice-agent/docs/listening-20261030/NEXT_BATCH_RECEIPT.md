# P003 倾听 Worker 下一批开发回执

## 2026-10-30 接续整改（当前结果）

**结论：确定 P1 已在代码与 job 层替身验证中关闭，普通 R18＋style/ark 候选可继续隔离联调。本轮未部署、未开闸；真实 RTC／Android 关房与重连仍待取证。**没有以“closed”日志或替身状态冒充设备断开。

| 项目 | 当前真值 |
|---|---|
| 分支 | `codex/p003-listening-worker-20261030`，沿用原工作树 |
| 开始 HEAD／精确回滚基点 | `9007bfd8ca7c1b34098b60403b43ae47aca97107`；开始时 clean，无并行修改 |
| P1 实现＋测试证据提交 | `962f2599bc1e6a2eff6c373b87e04958280377c5` |
| 本轮实际 HTTP 联合测试 Brain 提交 | `7fdba6e430c0ab3081b0ff4f83eba220b7f5c312`，32 个 Brain 输入逐项与该提交 `git show` 字节核同 |
| HTTP 合同 | version=1、`frozen_for_integration`；SHA256 `c4df5d49bd7addb09adbf6e06441c21b9b4e5e63e084b58a4f5599c66126e531`，未改协议 |
| fixtures SHA256 | `1c32e52ae65c6d2f0724d033def70e36eb345cc37b9c06f6bbb3a46e7d68ef2d`，未改 |
| 最终两次运行输入摘要 | 76 文件，SHA256 `7291a1e46756c2cfbc6d71118b5187b53aad61152f6543f234412dd87a2c4487`；本地逐字节核验，Linux 写入后再次核验 |

### P1 如何关闭、代码锚

原根因是 job 只监听房间事件与活跃任务心跳，pipeline 已结束后既无完成通知，又被 `!finished` 排除，无法保证进入原关房收尾。此次仅修改 `src/job.rs` 和 `src/pipeline.rs` 的生命周期接线及测试，没有引入守护进程、消息总线或通用生命周期框架。

- `src/job.rs:82` 的真实 selector 直接等待 pipeline JoinHandle；正常结束、Err、panic 均在 `:221` 退出事件循环，汇入原有统一收尾。已经 join 的 handle 立即取走，避免二次 poll；完成优先、watchdog 次之，房间事件洪泛不能饿死心跳/窗口检查。
- `src/job.rs:457` 复用 `close_pipeline`：候选合作退出仍最多 500ms，abort 后再给最多 500ms 确认资源释放；不合作任务也不能无限挡住关房。这里没有加长原有退出等待。
- `src/job.rs:446`、`:472` 统一执行 Room.close 与既有 DeleteRoom。Room.close 最多 3 秒，失败/超时仍尝试删除；删除沿用现有有界请求、错误及重试机制，不因进入倾听而改变搜索窗口。
- `src/pipeline.rs:1182` 的 fatal 改为记录错误并退出循环，经过原 ordered/STT/output 收尾后在 `:1434` 返回 Err。`src/pipeline.rs:665` 的本地 STT abort-handle 集合只负责该 pipeline 的主/次 STT 任务，Drop 时取消，覆盖错误、panic 和强制取消；主 STT 原有 3 秒等待到期后不再直接丢 handle 脱离。
- paused、禁止普通聊天/旧输出补播的逻辑未放宽；没有靠重启整个服务掩盖问题。Orchestrator 和搜索原有 Drop 清理保留，本轮不宣称已证明搜索泄漏。

### 本轮实测（与上一批证据分开）

| 验证 | 实际结果／边界 | 证据 |
|---|---|---|
| 完整 Linux `cargo test --offline --locked` | binary 480＋core 29＋runtime 7＝**516 通过**，0 失败；joint 默认 ignored 1 项 | [最终完整日志](evidence/lifecycle-linux.txt) |
| 现有 Rust→Brain HTTP joint，显式 `--ignored` | **1 通过**、0 失败；实际 HTTP／Hono／SQLite，隔离身份、manifest、模型与时钟 | [联合日志](evidence/lifecycle-joint-linux.txt) |
| 新增针对性用例 | 7 个 job 层用例＋1 个 STT 所有权用例；覆盖正常结束/Err/panic、取消资源释放及非合作上限、关房失败/卡住仍删房、None/live selector 与 watchdog、暂停旧输出及新会话隔离 | `src/job.rs:642` 起、`src/pipeline.rs:4350` 起；最终完整日志 |
| 暂停来源 | 替身链路覆盖租约过期、缺 local_ready、capture 未排空；授权超时使用真实 adapter 既有计时用例，再验证其 paused 状态的 job 收尾出口 | 同上；不冒充完整 RTC pipeline 集成 |
| RTC 边界 | 本轮关房／删除／重连为替身；旧许可、任务终止、收尾顺序执行真实 Worker 代码。NativeAudioSource FFI 回归也在完整套件内；均非设备扬声器或真实 Room 验收 | [最终源码清单](evidence/lifecycle-source-manifest.json) |
| 来源核对 | 76 个传输输入完全匹配；联合 bundle 的 Brain 32 个输入是已提交源码，不使用会话38未完成修改 | [bundle 清单](evidence/lifecycle-brain-http-bundle-manifest.json) |
| 只读复核 | 辅助评审确认原 P1 关闭，未发现新增 P1/P2；仅静态复核，不替代主实现实测 | 本回执记录；主实现仍由本会话 Codex 亲写 |
| 差分格式 | 已清理前批 6 份日志 EOF 多余空行；`git diff --check 4c900d9a` 通过 | 没有把之前仅工作树检查写成旧完整提交范围已通过 |

最终实际执行 **516＋1＝517 项通过**。前批 508＋1 及主会话后来只复跑的 29 core＋7 runtime 是历史证据，未混算成本轮执行次数。仍有 dead_code warnings，不称零警告。

失败证据保留：[完成监听／abort 等待 RED](evidence/job-lifecycle-red.txt)、[关房超时 RED](evidence/job-close-timeout-red.txt)、[STT／非合作取消 RED](evidence/job-stt-cancellation-red.txt)。主会话原最小控制流模型仅证明 guard 缺口，本轮新增用例使用真实 job selector／收尾函数，仍不冒称真实 RTC。隔离构建一度缺搜索 fixture、两处测试编译错误、一次 SSH 转发超时，均未算 RED，修正/重试后才运行。首次全套为 479 通过、1 失败、1 ignored，失败来自新 watchdog 用例对 Tokio 首 tick 的取整假设；改用明确过去的 tick 后复验，见[首次全套原日志](evidence/lifecycle-first-full.txt)。未隐藏失败或凑测试数。

构建机预检：根分区约 125MB 可用，`/data` 约 166GB 可用；本轮源码位于 `/data/p003-listening-worker-check-20261030-session39/lifecycle/2-Projects/realtime-voice-agent/rust-worker`，使用本会话已有独立 target，没有整份复制庞大缓存，没有安装/替换系统工具链或碰生产服务。代码、测试与证据已提交；本回执随后单独提交，并推送既有 origin 专用分支，最终以 `ls-remote` 对账。

### 回滚与下一步最小联调动作

精确撤销本次代码修复可另行在开发分支审查后执行 `git revert 962f2599bc1e6a2eff6c373b87e04958280377c5`，回到本轮开始 `9007bfd8` 的功能状态。只记录，不执行。**未部署，因此本轮没有服务器回滚动作。**本轮未打开倾听总闸、扩设备、修改搜索名单/窗口、Android 包或另一工作树。

下一步仅做隔离 RTC＋当前 Android 候选包闭环：记录版本/capability/完整 SN 与同 trace，依次触发租约失效、缺 local_ready 和 pipeline 异常；同时取得端侧真实断开原因、旧 Room SID 消失、新 room/session/trace、旧音频零补播的对应证据。关房 HTTP 成功和“closed”日志不能替代端侧断开。真实模型、自然故事/唱歌、墙钟撤权、体验/长稳及新→旧→新回滚仍分别待验，不要求本轮顺带完成。

R26 仍由会话24稳定其实际基线，之后再从该基线最小整合；本树保持普通 R18＋style/ark，没有整树覆盖搜索分支。

署名：codex（OpenAI）| 2026-10-30 12:35 CST

## 首轮 A／B 交付（历史：HEAD 9007bfd8）

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
