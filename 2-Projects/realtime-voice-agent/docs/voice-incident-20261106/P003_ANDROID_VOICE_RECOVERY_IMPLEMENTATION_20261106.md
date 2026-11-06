# P003 普通语音恢复修复与安卓联调执行单

本单替代“继续抓同一份失败日志”的安排。安卓侧先修复已定位的本地连接状态问题，再交付 APK 做定向验收；服务端已确定问题由服务端独立修复，不等安卓大重构。**不新增网络协议，不删除订阅门，不自动重放可能已执行的问句。**

服务端上线状态、候选 SHA、实际测试结果以同目录 `P003_VOICE_RECOVERY_RELEASE_20261106.md` 为准。本单中的安卓修改与验收项目尚待安卓交付，不能当成已通过。

## 1. 已知问题和责任

| 问题 | 证据 | 处理方 |
|---|---|---|
| 普通池 pipeline 已退出但房间继续挂着 | 服务端相同 WAV 的“不订阅输出轨”测试重复失败；灰度池会关房，普通池不会 | 服务端：接住任务结束，收尾后关房/删房 |
| Worker 从满载恢复空闲后，可用状态只等 30 秒心跳更新 | 独立单路池连续恢复时第三代没有派单；当前 worker.rs 只定时上报容量 | 服务端：任务状态变化后立即上报最新容量，保留心跳 |
| 同 trace 重连后使用了旧 ready | 原始日志里 G2/G3 被标 duplicate，UI 释放的仍是 G1 的时延载荷 | 安卓：连接、Worker、首句、UI 状态归属一起修 |
| 新一代已切 RTC，但界面仍等旧回答 | G3 收到可信 `session.input_phase reason=begin_timeout`，没有完成可见恢复 | 安卓：结束旧等待、提示一次、回 RTC；失败明确退出 |
| G2 没有当前输出轨的服务端订阅确认 | 安卓旧日志没有轨 SID；服务端记录 TTS 已产生 PCM、播放 0 帧 | 双方：按当前 participant/publication SID 留证、核订阅，不能据旧日志指认唯一责任方 |
| 部分连接约 10 秒失败 | 没有足够 DNS/TCP/TLS/WS/ICE 分阶段证据 | 安卓补实际连接阶段和有限恢复，服务端对同次 trace 查派单/SFU；不靠延长超时掩盖 |

固定审计源码为 `58f2a2d36bd81b4ad65ce1afb6ce6e42455a6f64`。它不是当前 APK 已校验的声明。请在当前开发分支检查下列同逻辑，做最小 diff，保留倾听、方舟、蓝牙绑定等后续改动，禁止整文件覆盖旧版。

## 2. 安卓最小修改范围

| 优先级 | 落点 | 必须达到的行为 |
|---|---|---|
| P0 | `LiveKitRoomAdapter.activateRoom / recoverPublisherBeforeFirstBusinessPublish / publishControl` | Room 被替换、room SID 或当前 agent SID 改变时，先使旧绑定失效并通知上层。事件携带来源绑定；发布前后重核绑定，旧 sender 不能把后续 chunk/end 发进新 Room。 |
| P0 | `VoiceRustWorkerClient.handleEvent / handleInputReady / onWake / finishWakePromptForReady` | ready 的去重和缓存绑定到本地连接代次、room SID、agent SID；同代重复幂等，新代可重新接收。旧协程完成、旧 ready/ACK/断连事件不能释放或关闭新代。 |
| P0 | `FirstTurnSession / FirstTurnOrderedSender / FirstTurnHandoffObserver` | 首句 sender、observer、ACK、TASK 都归所属输入尝试。换代取消旧等待，但保留“已提交或可能已提交”的事实。不能把旧 TASK 改成新代失败，也不能因换代自动再执行问句。 |
| P0 | `VoiceRealCanary.onInputReady / onFirstTurnFallback / checkIdleTimeout` | UI 的一次性 ready 门也按代次失效。fallback 不能只打日志：退出 thinking，恢复当前 RTC 麦克风与正常 idle，提示一次；恢复失败能退出并重新唤醒。 |
| P1 | Adapter 轨发布、订阅、sink 管理 | 保留 autoSubscribe。只绑定当前 agent 的当前 publication；缺订阅时在恢复预算内复核/补订阅一次。旧 sink 的 final/静音统计不能覆盖新代状态。 |
| P1 | `VoiceReadyDiagnostics` 与连接入口 | 同步日志白名单和条数预算，记录代次、room/agent/track SID、probe、首包实际发布、阶段耗时和终态。未知网络阶段记 unknown，不记录 token、SDP、原始音频或用户正文。 |

**本地代次即可，无需服务端新增 generation 字段。** trace 和房名可能跨新房/新 Worker 保持不变；不能单独作为去重键。普通 SDK 临时重连若仍是同 room/agent，不盲目新建业务任务；仅音轨重发时，只重建输出订阅，不重放首句。

不能只靠取消 collector：已经进入 SharedFlow/回调队列的旧事件仍可能到达，消费处也必须核归属。当前事件 collector 等 UI ready gate 时，要允许换代同步失效并取消旧等待，避免通知被堵在它后面。

## 3. 首句与失败恢复合同

1. **尚未发布业务 begin：** publisher probe 和必要重建先完成，再把 sender 绑定到最终 Room。原采集仍完整有效时，可首次发送一次。
2. **已经发送一部分：** 本轮最小方案可以直接提示重说、回当前 RTC，不要求新增缓冲重放系统。不得用旧 seq/ACK 续发到新 Worker。
3. **end/receipt_done 已尝试，或收到 TASK/commit：** 视为已提交或结果未知，不自动重放；无声音、无 ACK、超时都不能证明未执行。
4. **当前代收到可信 phase=rtc / begin_timeout：** 以现有信令语义验证来源；取消该代旧首句等待，停止向已切 RTC 的 Worker 补 begin。仅收到 input_phase 也能完成恢复，不依赖另一个结果包必达。
5. **用户提示：** 一次“刚才没听完整，请再说一次”或等效现有提示；提示失败也必须退出等待，文字或明确失败兜底。保留现有提示时限，不能无限 await。
6. **有界恢复：** 一次唤醒最多一次应用主动 Room 替换，连接失败与 publisher recovery 共用预算，换代不能重置预算。保留原 10 秒连接失败退出也可；如增加一次重试，建议整条连接恢复总上限 25 秒，阶段共享剩余时间，鉴权失败/用户退出/取消不重试。不要叠加多个 10 秒无提示等待。
7. **保留已完成能力：** 倾听状态、用户退出、设备命令幂等不可随 ready 重置丢失；不能为恢复普通聊天破坏有效倾听权限或复活已关闭会话。

## 4. 交付与定向验收

请先提供：源码 commit、APK SHA256、安装 versionCode、修改摘要、以下端侧单测/模拟事件结果。设备优先用现有安卓开发机尾号 **03800006**，另一台问题机 **02000038** 做后续复验，不必先扩大设备范围。

| 用例 | 数量 | 验收点 |
|---|---:|---|
| 正常普通聊天，同一份语料 | 两池各 5 轮 | 当前轨有可听正文、自然播完；无重复首句、无多余恢复提示 |
| G1 已缓存 ready，首包前 probe 重建 G2 | 3 轮 | G1 缓存失效；G2 ready 有效；只对最终有效目标首次发送 |
| 同 trace 新 room/agent；旧 ready/ACK/phase/sink/断连迟到 | 逐类注入 | 旧事件被拒绝且不改变新代 UI；当前事件正常处理 |
| G2 输出门失败 → G3 缺 begin → RTC 再说 | 3 轮 | 旧房自动关闭；G3 一次提示、退出 thinking；再次说话有声，无旧问句自动重放 |
| end 发布超时、已 commit 后重连 | 各 2 轮 | 提交事实保留；不自动重复执行；恢复结论明确 |
| 连接失败、probe 恢复再失败、用户恢复中退出 | 各 1 轮 | 阶段和总预算有界；无后台循环；退出后不复活旧会话 |
| 倾听进入、连续讲述、退出、同房聊天与再次唤醒 | 1 组 | 保持 v386 已通过能力，UI/idle 正常 |

服务端逐轮对账 `trace → room SID → job → agent publication SID → ASR → TTS 首 PCM → output_ready → 实际播放/自然结束`。安卓回传同一轮的连接代次、当前轨、输入提交状态、UI 恢复结论和可听音频统计；不用重新上传之前同一份失败包。

自动化 MacBook TTS 可以复测固定语料，但最终至少补一组真人口述与实听。服务端 Python 探针通过只覆盖服务端链路，不能替代安卓 ready/UI/扬声器验收。

署名：codex（OpenAI）| 2026-11-06
