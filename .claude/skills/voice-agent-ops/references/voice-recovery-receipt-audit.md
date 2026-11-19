# 语音恢复回执与故障注入验收

用于安卓报“普通对话/恢复测试通过”后的服务端复核，以及 capacity、no-subscribe、output-gate、Worker replacement 专项。它不扩大生产操作授权；历史结果与当前运行版本分开归档。连接分段与恢复预算继续参考 [TTS传输取证](tts-transport-recovery.md)。

## 先建立能回答问题的关联键

按附件逐条列 trace（先核集合与分母），由历史签票确定设备、实际agent，再关联 room name、Room SID、job ID、Worker PID及启动时期、Worker participant SID、publication SID。房名末8位不是Room SID；`process exiting`可能是job任务退出，须按固定源码解释，不能当守护进程重启。

journald `MESSAGE`兼容字符串/字节数组。ASR/TTS无room字段时，先用有键事件构造**全部覆盖job区间**并核同PID是否重叠；仅在唯一归属时关联无键行。按当前保留策略清理后的authority空表，不能推翻历史成功签票。原始正文/凭据留源端，分享白名单字段、脱敏ID、行号与hash。

## 不让不同层的成功相互替代

| 观察 | 能证明与不能证明 |
|---|---|
| 客户端`FINAL_AND_ANSWER`、助手字幕 | 客户端流程/文本有结果；仍需查provider正文PCM与实际播放 |
| `SourceDrained`、body first frame | 某条播放队列消耗/首帧发布；可能是垫句或搜索回执，不能单独判正文TTS成功 |
| provider首PCM | 该连接曾产出PCM；不保证同轮所有后续建连成功，也不等于扬声器实听 |
| `no_final`但有采样计数/能量 | 已接收音频而没有识别final；不能写成未收音、纯静音或直接归责安卓 |
| `CaptureFailed` | 对齐同turn的abort/cancel、重试及关房时序；不能一律当输出门故障，晚到的cancel也不能倒置成原因 |
| `resolve_tcp`超时 | 组合阶段超时；无细分证据不能断言DNS、TCP或某供应商是根因 |

计时保留事件名、起止点与时钟：SDK connect_end不是input_ready；provider首PCM不是用户开始提问到可听正文的总时延。

## 四项异常分别取证

- **capacity**：只在独立测试Worker限制槽位，核active/max/available、第二房未过量assignment、释放后真实input_ready与回答。SFU遵守available=false时可能根本不发第二次offer；无decline日志不否定“无超卖”，但不能宣称直接拒绝分支已测。白名单拒绝可能复用full-capacity文案，须核active与路由条件。
- **no-subscribe**：有确实会产出PCM的输入，在门截止前核当前publication没有有效订阅、无output_ready、服务端无PCM泄漏、客户端无可听帧；只有客户端0声音不够。
- **output-gate failure**：从首个待播PCM触发的门计时，核精确底层原因、零泄漏、pipeline收尾、自然删房，再验新房回答。按当前合同取超时值；看门狗、RTC协商失败或主动断开不能冒充门失败。不同池外层错误文案可能不同，不能只grep某池的wrapper，也不能放宽为“任意断连即通过”。
- **Worker replacement**：先冻结对象。远端`dev-<sn>`更换SID并重发输出轨，和本地`agent-{job_id}`更换是两回事。设备启动前替换、旧房结束后换Worker开新房、同房Worker更换、突然进程崩溃后的孤房处理分项记录。新房恢复不能替代同房旧publication拒绝；仅诊断用途的output_ready包若不含身份键，不能承担客户端绑定判据。

## 测试器、版本和归档

用固定运行字节和有界私有SFU做故障测试，记录源码/磁盘/proc/探针/runner hash及实际agent条件。普通隔离agent可能绕过候选准入；合成LLM不覆盖真实业务路由，SDK不覆盖Android渲染。按覆盖范围给PASS，不为测试失败直接增加生产故障开关或改全局容量。

夹具错误保留首失败；确认实现还是断言出错后，只修所需部分，并重跑受影响用例。同名测试在两池通过前核语义而非文案一致。按“唯一场景/实际执行次数/复验后的结果”报告，不将多轮合并冒充一次全绿。记录测试主动删除的未分配房、故障兜底删除、Worker自然删除三者；cleanup标志为0不能掩盖夹具已主动删除。

独立评审的历史结论、后到证据和最终裁决分别注明适用范围。修改私有fixture兼容旧编译器的单测，不能计作原crate或正式二进制通过。档案不完整时先补已有证据；不要仅为补日志改线上协议。生产需要改动时再建当次回滚点，尤其保留后来轮换的新凭据，不套更早env。

本项目实例与脚本：`codex/p003-voice-input-routing-fix-20261110` 分支的 `2-Projects/realtime-voice-agent/docs/v389-joint-20261110/`；先读最终中文回执、`REVIEW_RESOLUTION.md`及`ACCEPTANCE.json`。旧日期、设备、PID、版本和5秒门均为实例，不作为永久默认值。
