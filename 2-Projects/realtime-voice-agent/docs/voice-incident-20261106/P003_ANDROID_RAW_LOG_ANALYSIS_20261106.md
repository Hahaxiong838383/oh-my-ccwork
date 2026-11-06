# P003 普通语音失败：安卓原始日志联合分析

日期：2026-11-06（北京时间）；设备尾号03800006；客户端回执版本v386。

**结论：已证实重连后继续使用旧任务就绪状态的缺陷，并解释了为什么新任务的首句超时没有恢复成可用对话。G2输出门未就绪的直接原因仍需定向取证，A的连接失败也尚未定位到具体网络层。本轮是分析结果，不是修复上线回执。**

本报告更新此前`P003_ANDROID_FAILURE_SERVER_RECONCILIATION_20261106.md`的未取证部分，并纠正“五次均约10秒”和“11:36:02.641是收到新input_ready”两处旧口径。此前报告作为历史证据保留，不覆盖。

## 1. 原件与核验范围

- ZIP SHA256：`122aa6ce2ebedddfbd1ef50d592738cbf1f07e4406872535883f63609df919e3`。
- README列出的4份日志及失败回执共5个文件，SHA256全部核同。
- `01`为`01_logcat_live_full_window_sanitized.txt`，34319行；`02`为失败摘要，37行；`03`为最后一轮详细时间线，128行；`04`为持久聚焦记录，2000行。以下使用解包后文件的物理行号，`04`行内附带的旧行号不是本报告的行号。
- 服务器证据沿用已独立复取的Brain、SFU和倾听Worker历史记录；本轮没有再次登录生产服务器或操作生产。
- 客户端按已交付v386源码`58f2a2d36bd81b4ad65ce1afb6ce6e42455a6f64`只读核验；原日志未附现场APK校验值，源码解释不冒充对实际APK字节的独立验证。
- Grok独立核B，Codex独立核A，主13复核关键原文、源码和证据边界。原始日志保存在私有目录，不将其中用户正文提交代码仓。

## 2. B现场：根本问题落在重连与状态恢复

trace：`b874ed69-1614-4547-bdf1-b522558ccddd`。服务端三代job已确定：

| 代次 | Worker job | roomSID | 服务端agent trackSID |
|---|---|---|---|
| G1 | `AJ_DbBjN5VB47oZ` | `RM_mEFRuUuQs5QR` | `TR_AMUPL6mGJY3js5` |
| G2 | `AJ_N5Zt7m3QYfag` | `RM_3qk9GiHYh76F` | `TR_AMUdysXtFYTMpt` |
| G3 | `AJ_cMdP7R2ERBQ2` | `RM_zYXPHLbKQw9W` | `TR_AMhMSNUZq5Fcte` |

以下客户端时间均直接来自01；跨机时间未校准，不用两端墙钟差冒充网络耗时。

### 2.1 G1并非用户主动关房：发布探针触发了应用重建

| 客户端时间 | 原始事实 | 行号 |
|---|---|---|
| 11:35:50.588 | connected | 29211 |
| 11:35:51.315 | remote_audio_subscribed | 29219 |
| 11:35:51.894–.897 | input_ready经过SDK和client，随后`ready_step=cached` | 29239–29243 |
| 11:35:51.899–.901 | output_ready到达SDK和client | 29244–29246 |
| 11:35:52.166–.167 | `publisher_probe_failed type=Timeout attempts=3`，随即`publisher_recovery_start reason=probe_failed` | 29249–29250 |
| 11:35:57.118 | `publisher_recovery_connected room=fresh` | 29451 |
| 11:35:59.082–.089 | 新连接探针成功、business_ready recovered=true，之后才记录first_turn_begin | 29465–29467 |

v386的`LiveKitRoomAdapter.kt:341–431`与这条路径一致：首个业务包前执行发布探针，每次700ms、最多3次、间隔150ms；失败后取消旧Room事件收集、主动disconnect/release，再创建新Room并复用原credential重连。**这里检测的是可靠数据发布通道，不能用已订阅下行音轨证明该上行通道已经可写。** 探针本次是否因阈值过紧误判，尚未证实，不能直接删掉探针。

这补齐了服务端G1的`CLIENT_REQUEST_LEAVE`来源：与应用主动恢复路径一致；不应再把它解释为用户点击退出。首句发布返回成功的日志出现在唤醒后12643ms，界面就绪在唤醒后16199ms。它们是设备内已记录耗时。

另一个时间戳易被误读：服务端begin中的`device_sent_at_ms`对应设备11:35:49.760，而客户端`first_turn_begin`日志在59.089。主13核`FirstTurnOrderedSender.kt:41–51,179–200`：header的`sent_at_ms`先生成，再进入`publishControl`等待探针/恢复，返回后才打begin成功日志。因此它并不代表真正出网时间，不能把这段差值直接算成网络传输耗时。Grok把它保留为未解释差值；主13补充了上述源码记录点解释，尚无逐包出网时刻可供测量。

### 2.2 已证实：旧input_ready跨连接保留，新任务ready被当成重复

| 客户端时间 | 观察 | 行号 |
|---|---|---|
| 11:35:51.897 | G1的ready被缓存 | 29243 |
| 11:36:00.938–.940 | G2的ready到达SDK/client，却标为duplicate | 29500–29504 |
| 11:36:02.630–.635 | G2首句完成，释放此前缓存ready | 29528–29538 |
| 11:36:02.641 | UI显示input_ready，载荷`issue_to_assignment_ms=2137 job_room_connect_ms=449 track_to_input_loop_ms=42` | 29543 |
| 11:36:23.451–.453 | G3的ready再次到达SDK/client，再次标为duplicate | 29931–29935 |

2137/449/42这组数对应G1；G2的派单耗时是6668ms。故**11:36:02.641是旧ready经过客户端缓存释放后更新UI的时刻，不是新Worker此时才下发ready。** 不能用这行证明G2在02.641完成输出或整个会话健康。

源码证据：`VoiceRustWorkerClient.kt:1383–1449`按`inputReadyTraceId == traceId`去重，缓存`pendingFirstTurnReady`；`LiveKitRoomAdapter.kt:380–418`替换Room时没有通知上层清除该业务状态；同trace、同房名在三代间不变。G2/G3的新ready因而被旧trace状态挡掉。`VoiceRustWorkerClient.kt:338–343`明确释放此前缓存。

**这是可直接安排修复的缺陷。它解释就绪显示和恢复状态失真，但不能单独解释Worker的G2输出门为何未打开，两者需分别处理。**

### 2.3 G2：服务器有回答，实际正文播放仍为0

服务端已经接受93个ordered包（91个PCM chunk），产生ASR final和LLM正文；11:36:02.908收到TTS首PCM，provider TTFB246ms。输出门未收到匹配的就绪确认，约5秒后失败，正文`played_frames=0`，服务端删除G2房间。

原日志补充：Android在11:36:06.984出现第二次`remote_audio_subscribed`（01:29613），之后有静默回调，直至11:36:17.510该sink结束（01:29766–29767）。它与Worker未观察到输出就绪之间仍存在待查缺口。**不能把Android本地TrackSubscribed直接等同Worker已经收到LocalTrackSubscribed，也不能只凭时间接近断言服务端SID过滤错误。**

此包01中没有任何`TR_`、`RM_`、`PA_`值；已读的客户端实现也只记录“订阅发生”，没有打印被订阅轨SID。故三段sink与服务端三条轨只能做时序关联，无法逐SID闭合。附件已经完整交付，缺的是当时没有记录的字段，不是要求再发一遍同样文件。

### 2.4 G3：连接恢复后仍用旧首句状态，超时未转化成可见恢复

服务端G3输出门已开；11:36:23.428开始输入循环，25.930因本代无begin进入处理器，约2.5秒后切RTC；该job的ordered包计数0。

G3实际由哪一层发起重连尚未记录：客户端没有第二次应用`connect_start`或`publisher_recovery`，SDK诊断序号也没有再次清零；SFU记录restart失败后出现新的participant/job。不能进一步指定某个SDK重试定时器为已证根因。

客户端11:36:26.488收到`session.input_phase`，26.489业务层记录`reason=begin_timeout`（01:29970–29972），但没有新的`first_turn_begin`、`first_turn_phase outcome=FAILED`或恢复提示记录。最后11:36:42.482由`voice.wake.exit reason=touch_exit`结束（01:30197–30205）。等待期间idle倒计时持续`running=false`（例如01:30194），并未自动恢复成一轮新回答。

v386源码给出一致解释：

- `FirstTurnHandoffObserver.kt:57–85,103–113,135–163`保留旧ACK/结果；已确认begin后，不接受“没有begin”的超时；已有TASK后，不接受另一个FAILED结局。这对同一任务的幂等约束合理，但本次Worker已经换代。
- `FirstTurnSession.kt:138–193`只创建一次sender，首句handoff完成后不因新Worker重新建立状态；重说提示检查发生在首次`awaitHandoff()`完成后（`VoiceRustWorkerClient.kt:291–299`）。
- Adapter没有向上转发Reconnecting/Reconnected或Worker代次变化；普通ready也只以trace去重。因此新job的失败被交给旧的首句观察器，通用onControl仅记下phase（`VoiceRealCanary.kt:366–400`），没有形成新的恢复提示。

源码和现场状态相互吻合，**确认应修复跨job恢复语义**。本轮没有编译客户端或在真机注入重放，不将静态控制流审计称为修复测试通过。

服务端确实构造了`action=repeat_prompt`的OPCM结果并调用发布路径（`ordered_pcm.rs:777–790`、`pipeline.rs:1621–1651`）；现有日志没有该包的到达/解析确认。端侧已证收到的是`session.input_phase reason=begin_timeout`。不能写成“已证收到repeat_prompt却故意忽略”。

## 3. 纠正静默统计的解释

01中有3次sink结束汇总：

| sink统计窗口（Android） | 回调数 | 音频时长 | audible_ms | 结束证据 |
|---|---:|---:|---:|---|
| 11:35:51.348–52.179 | 84 | 840ms | 0 | 29253–29254 |
| 11:36:07.003–17.510 | 1053 | 10530ms | 0 | 29766–29767 |
| 11:36:18.677–42.597 | 2397 | 23970ms | 0 | 30223 |

这不是同一音轨连续23秒的证明。`audible_ms=0`也不是逐样本全零证明：v386按PCM16每8个样本抽查一次，绝对值达到256才标可听（`LiveKitRoomAdapter.kt:609–634`）。它证明未达到该检测阈值。Worker正文播放0帧，则是独立的服务端证据。

采集侧`capture_silence`在11:36:02.634解除（01:29533），触摸关房时才再次开启（01:30211–30213）。当前证据不支持“倾听模式一直把麦克风静音”这一解释；服务端后续低能量上行也不能单独判断用户是否说话或麦克风硬件是否异常。

## 4. A必须拆成两类失败，不能继续统称五次10秒

| 尝试 | started→wake_connect failure（设备内计时） | 已证阶段 |
|---|---:|---|
| A1 `fbb99709…` | 4.192秒 | NetworkTimeout；没有已取得session_bound/RTC开始证据 |
| A2 `723232f0…` | 4.176秒 | 同上 |
| A3 `feb0deb3…` | 4.177秒 | 同上 |
| A4 `d0a7d6ed…` | 4.178秒 | 较完整上下文仍未见绑定/Room connect；另有预取超时旁证，不能直接等同本次失败 |
| A5 `1fc1ddd4…` | 10.289秒 | 已绑定会话；Room connect_start→connect_failed为10.121秒 |

依据02:1–35、03:31–37/114/122–127、04:17–92。A5服务端签票9ms，与客户端session和room匹配；对应SFU/Worker留存窗口仍没有入场/assignment。前四次服务端无trace映射，与客户端未见绑定相容，不能用它们证明Worker四次开房很慢。

A5只有`TimeoutException>TimeoutCancellationException`，没有底层堆栈或实际RTC endpoint。**当前不能区分DNS/TCP/TLS/WebSocket/Join/ICE，也不能把它定为“TLS超时”或“安卓网络故障”。** 当前配置、普通HTTPS心跳及B的DTLS日志均不能替代A的历史证据。主13此前“五次约10秒”表述在此纠正。

## 5. 是否为搜索/倾听改坏，以及谁来修

- 本次B由倾听灰度池处理，普通问句走chat，未执行搜索任务；ASR/LLM/TTS已有产出。当前证据不支持“搜索服务等待卡住了这轮答案”。
- 云端10月30日新增pipeline失败后主动关房、之后新增输出轨SID过滤，确实改变了共享生命周期；G2走了失败关房路径。SID误过滤仍只是候选原因。
- 原日志证实Android的探针恢复和上层业务状态没有同步换代。现有客户端镜像历史不完整，不能把这一缺陷的首次引入日期归到倾听重构或某个作者。
- 应按**云端输出就绪/失败恢复 + 安卓连接代次/首句/UI状态**联合修复。仅改服务器超时、仅重启设备或仅清一次缓存，都不能补齐该契约。
- 本次没有证据认定服务器硬件或容量不足。此前主池正常探针也不能给这条倾听灰度重连路径免责。

## 6. 最小改造与定向验收

| 负责侧 | 必须处理的内容 | 验收要求 |
|---|---|---|
| Android | Room替换、SDK重连、远端Worker变化要通知上层；复用现有连接/participant身份区分代次。旧ready缓存清除，新ready只对当前代生效 | G1缓存ready后重建G2，UI必须显示G2；同代重复包仍幂等；不得把已关闭G1的2137ms载荷用于新代 |
| Android | Worker换代时分开处理未发首句、已提交未听到回答、正常聊天恢复；清理旧TASK/等待回答状态，给明确的一次恢复/重说提示 | 已提交的问句不得盲目重放而重复执行副作用；G3 begin_timeout不能只有日志、没有用户可见恢复 |
| Worker/SFU（主13） | 补当前publication SID、订阅事件SID、接受/忽略原因与job/roomSID；结合SFU订阅状态确定G2缺失确认原因，再修对应路径 | 当前轨订阅应打开门；旧轨不能误开门；正文确实进入音源并由真机收到可听音频，不能只看TTS成功 |
| Worker（主13） | 核对输出失败前的明确失败/关房通知，以及新job输入策略与客户端恢复的一致性 | 复用已有控制能力，失败有界收尾；恢复成功或明确请重说，不遗留长期thinking/静默房 |
| 双方 | A记录实际目标host/port/path、取票fresh/cache/prefetch分支、attempt/trace、每阶段单调耗时和脱敏异常链 | 先区分4秒准备失败和10秒连接失败，再定位具体层；不记录token或完整SDP |

先补已证的代次缺陷与必要日志，不新增复杂的跨房PCM持久化或自动重放系统。服务端G2具体修复仍以订阅确认取证为准，不能直接删除SID过滤。

定向验收覆盖：正常普通聊天5轮；G1就绪后触发一次发布恢复；首句提交后输出门失败并恢复；新Worker begin_timeout恢复；同代重复ready、旧代迟到ready、旧轨订阅不污染新代；A的准备/连接失败各抓到一次明确阶段。以上均是**待执行用例，不是已通过**。必须使用目标灰度池，记录真实音频接收、状态、关联代次及失败原因。

本轮只读分析及证据归档，未修改业务代码、未部署、未重启、未安装APK。没有要求同事重复发送已提供的日志；旧现场没有记录的字段，需要先补定向采集后再复现。

结构化对账、原件SHA、源码SHA和行号见同目录`P003_ANDROID_RAW_LOG_EVIDENCE_20261106.json`。已运行原件校验、同端耗时重算、ready来源匹配和3段sink统计断言；这些是证据自检，不是功能修复验收。

署名：codex（OpenAI）| 2026-11-06
