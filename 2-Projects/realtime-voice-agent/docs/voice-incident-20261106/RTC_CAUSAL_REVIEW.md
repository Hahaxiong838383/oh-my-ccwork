# RTC 因果复核（只读）

**分析完成，RTC 根因未闭合。没有证据可把两次新增音频协商超时定性为“倾听改造拦住 Android answer”，也没有足够证据给出能恢复订阅的确定服务端补丁。已证实的服务端行为是 output gate 超时后删房，属于故障放大/恢复边界，不是新增 offer 卡住的原因证明。** Brain 备用 provider 已由主13恢复，DeepSeek 正常，不解决此 RTC 断点。

## 已证

- 038 / 11:23、048 / 11:52：Subscriber 已完成仅 datachannel 的 offer/answer；新增 audio mid=1 留在 localPending，约15秒 NEGOTIATE_FAILED。只证明 SFU 未成功应用这代对应 answer；**不能证明 Android 没生成/没发送 answer，也不能证明 server 没发或已成功投递 offer**。`remotePending=null` 单独尤其不能代表从未收到 answer。见 `sfu-evidence.md` record 10、452。
- 038 / 房尾1793936147：`worker-current.json` 的同房日志明确记录 11:36:07.980791 output gate 5s 未就绪 → job AJ_N5Zt7m3QYfag 终止 → 11:36:08.021816 `room deleted (delete_room_on_close)`；与 SFU 07.999 DeleteRoom 对上。此前 TTS 已产出。按已确认历史，这是8月既有失败收口；**不采纳旧 job/ownership 竞态作为既定解释**，也不把这房未订阅自动等同于另外两房的15秒 SDP 超时。
- 精确 v386 源 `58f2a2d36bd81b4ad65ce1afb6ce6e42455a6f64` 中 `LiveKitRoomAdapter.kt` 已实际读到（blob `a9dc7fc36d74174d8787a05cd4b6a33dce78bb41`）。首次/恢复连接均 `autoSubscribe=true`（287、407行）；`publishAudio` 只配置本地音频发布。TrackSubscribed 回调在156–160行接收已订阅远端轨；本地停音/恢复方法445–468行没有取消订阅或处理 SDP。
- 本轮逐字比较：该 Adapter **v371 = v382 = v386**；v370→v371 唯一差异是控制消息 sender 增加 `participantSid`。首次业务数据的 publisher probe、失败后 `disconnect/release/createRoom`（343–420行）倾听前已存在。不能把这些旧恢复机制归为倾听新增。
- v386 回执记载11月5日038三轮退出倾听后同房普通问答成功；仅是这些用例通过。不能证明11月6日038/048实际安装的 APK、SDK 或新建房协商健康。此前 v371–v382 的 Client→Controller / Controller→Client 反锁序有历史隔离复现，但后续已有 `2b0d1d8 fix(voice): prevent listening stop deadlock`，不能把旧锁环直接套给 v386。

## 精确调用链与仍需验证的假设

实际用本地 `javap` 读取缓存 **LiveKit Android 2.27.0** 字节码，不冒称拿到了 v386 APK 内 SDK 源码：

`SignalClient.onMessage(binary)` → `handleSignalResponse/responseFlow` → `handleSignalResponseImpl` 校验 currentWs、取 offer.id → `RTCEngine.onServerOffer` 在 engine scope 启协程 → Subscriber `setRemoteDescription` → `createAnswer` → `setLocalDescription` → `SignalClient.sendAnswer(answer, offerId)` → WebSocket。

其中 SDP 三阶段失败会记录对应 error；engine closed 可提前返回；PCT 的操作需要 RTC thread。**ANSWER 在 skipQueueTypes 中，绕过普通 requestFlow 队列直接发送**；断开/currentWs 缺失会返回，`WebSocket.send=false` 会记发送失败。因此业务 datachannel ACK 堵住，不等于 SDP answer 被同一个发送队列堵住；send=true 也仅是本地接受入队，不是 SFU 收到/应用的证明。

| 假设 | 代码支持与证伪点 |
|---|---|
| 倾听业务 collector/锁阻塞，间接拖住 RTC | Adapter 是顺序 `collect`，向容量32的业务 SharedFlow `emit` 可挂起（54–56、144–208行）。这能解释事件迟报，但尚缺“阻塞传播到 SDK 信令/RTC thread”的实际等待链；不能仅凭 collector 卡住解释无 answer。需同代次线程栈/SDP阶段日志。 |
| 进入倾听/恢复/退出触发 close，打断当前协商 | SDK 确有 closed、旧 WebSocket 丢弃和失败发送分支；Adapter 也有换 Room 路径。须在故障窗看到对应 close/recovery、Room/PC/WS 代次切换才成立；现有 SFU pending 不足。该恢复路径不是倾听新增。 |
| offer 未投递/旧连接投递，或 answer 未送达/未被应用 | 均与现有 SFU 状态相容。必须两端按 offer.id 与连接代次对账，不能选择性归责端侧或服务端。 |

源码缺口明确：本地 partial mirrors 有 v386 commit/tree 和 Adapter blob，但本次在禁用所有 Git transport 后，v386 `VoiceRustWorkerClient.kt`、`ListeningVoiceControl.kt`、`VoiceRealCanary.kt`、payload build.gradle blob 均不可读；未 fetch。故不能重新确认最新控制器全部锁序，也不能确认缓存2.27.0就是故障包 SDK。v386 PREPARING 仅冻结普通 idle、回 NORMAL 重开5秒预算的描述来自回执，不当作本轮完整源码复核。

## 服务端能做什么

1. **当前无确定的 SFU 修复依据。** 没有逐代 offer 写入结果、answer 接收/应用错误，也没有现役 SFU 对应代码分支证据；不建议猜测修改自动订阅、SDP 或升级 SDK/SFU。
2. **已有证据支持优先沿用单会话 full reconnect 恢复。** 048同房重连后恢复设备音轨与双 transport，只证明传输层恢复，仍需普通问答实听。未删房时不必一律 DeleteRoom/换 token；已删房时再走既有新会话流程。本轮未执行恢复。
3. **output-gate 删房可以作为窄范围恢复策略候选，不能宣称已修 RTC。** 若主13确需改，只针对“未订阅导致 output gate 失败”评估让该失败进入既有有界重连流程，避免只删房而无恢复；需要确认端侧能消费恢复动作，否则保房可能只延长无声。合法退出保留，不直接取消所有清理、延长全部超时或新增 ownership 框架。5秒业务门与15秒协商门不一致是恢复观察点，不足以据此把5秒统一调大。
4. Grok 已识别的 Thinking pause/短 commit abort 是其他房间的独立普通对话故障候选；不能用它解释这里的 SDP pending。无需为 RTC 关闭打断、强制 TURN，亦无需重复全部取证。

## 最小精确 Android 取证（只要一条自然失败会话）

统一关联：设备尾号、trace、roomName + room SID、participant SID；每条带墙钟及 elapsedRealtime、Room/engine/PC/WS 代次，Publisher/Subscriber 分开。

| 字段/节点 | 必须记录的最小值 |
|---|---|
| 实际安装态 | versionCode、APK SHA256、SDK/WebRTC 版本；不能用仓库 HEAD 代替 |
| offer 收到与派发 | WS代次、是否 currentWs、offer.id、SDP类型、mid集合/媒体方向摘要、response入队/派发时间；不存完整SDP/ICE凭据 |
| 三个 SDP 阶段 | setRemoteDescription / createAnswer / setLocalDescription 的开始、成功或原始错误、耗时、前后 signalingState、engine/PC closed/cancelled |
| answer 发送 | 对应 offer.id、answer mid摘要、isConnected/currentWs、WebSocket.send 返回值/异常；与 SFU 同代 answer 接收和 SetRemoteDescription 结果对账 |
| 生命周期/业务门 | connect/reconnect/recovery/disconnect/release 原因；NORMAL/PREPARING/LISTENING、proposal动作、idle触发时间；说明失败前是否实际进入倾听动作 |
| 远端音轨与卡点 | agent SID、track SID、TrackPublished/TrackSubscribed/TrackSubscriptionFailed 时间与错误；某 SDP 阶段卡住时取一次 RTC/信令/业务线程等待栈，包含锁持有者，不要求全量持续抓取 |

对应 SFU 最少补同 offer.id/participant/连接代次的 offer 写入结果、answer 接收及应用结果。Android收到但 SDP 阶段停住才查该阶段；Android send成功但SFU未收才查传输；SFU收到但应用失败才定位服务端 SDP 错误。恢复验收只需一次新建普通会话完成新增音频协商、首声及连续问答，无需重跑全部倾听矩阵。

证据定位：本目录四份 urgent/evidence 报告与 `worker-current.json`；精确 Adapter 来自 `../p003-v380-coordination-20261103/client-v380.git`；历史对照为 `../p003-android-listening-ready-audit-20261103/evidence-38/snapshots/{v370,v371,v382}/LiveKitRoomAdapter.kt`；回执为 `../p003-v386-closeout-20261105/P003_G2_V386_LISTENING_PREPARING_IDLE_RACE_FIX_AND_DEVICE_ACCEPTANCE_20261105.md`。SDK缓存 `~/.gradle/caches/8.9/transforms/c20521ca4a17ab262e1352f99c7dfaa6/transformed/livekit-android-2.27.0-runtime.jar`，SHA256 `bb49699d80276d0d31e847f460ec15373362cf67b5f45394aa3dce36130c9199`。

本轮仅本地读取、Git对象/字节比较、SDK反汇编；仅新增此报告。未SSH、联网拉取、外部发消息、改业务/生产或运行设备测试。

署名：codex（OpenAI）| 2026-11-06 12:21 CST
