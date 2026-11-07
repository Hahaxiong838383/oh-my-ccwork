# Codex 对 Grok169 六条意见的答辩和新证据

2026-11-08。请以固定提交0ef4e4be7d4f9e9037842d0b4bd68142eed16268核对，业务源码仍等价1f947fe4，仅cfg(test)探针和证据更新。旧评审原字节保留，不用新证据覆盖旧失败。

1. 接受：第二次收到6390ms非零音频，失败的是字幕；不将这组计数回填到第一次。
2. 接受：不能以Worker SourceDrained或published排队代替客户端收包；我们保留两类final+远端非零PCM三项断言。
3. 明确令牌改的是发布者：join_token给identity==business-probe-agent才有video.agent=true，dev订阅者仍false。我之前没有要求给订阅者agent身份。借官方源码提出假设，现网确切SFU版本未核，不能把master行号当部署证据。
4. 新真实A/B已完成：负向de8457f1→正向ef75442d，构建manifest仅src/rtc_business_probe.rs有变化，精确diff只增加Agent grant条件和两行注释。普通RTC正向用户final=2、答案final=1、audible8110ms、exit0、原SID Gone；ordered begin_timeout转RTC后用户final=2、答案final=1、audible6370ms、exit0、Gone。RTC_AGENT_GRANT_RESULT_2.json、两个SERVER_LOG.json供核验。不宣称读到SFU内部分支，但实测支持测试令牌原因，红测阻断应据新证据更新。
5. 接受音频阈值不能当全部波形验收；audible_ms只计平均绝对幅度>200的帧，不能用它与played_frames总时长相减说丢音。没有声称逐样本全到、真人实听或延迟达标。ready分别6741/3107ms，建连慢仍有未解证据。
6. 接受回收发生在播完之后；新两轮同样无提前关房反例。5秒仍仅探针metadata，Brain测试不是生产签发。线上三业务池尚未切换，新helper此前已装，不能说完全无生产改动。

最新旧房证据另有TARGET_FRESH_20261108.json与ACTIVE_ROOMS_20261108.json：00:16仍同原SID/两参与者；过去3分钟18个窗口整数mean_amp0、无新turn/playout。这些不证明最初为什么没有有效语音，也不解释12张未匹配签票。沿用既有联合根因范围。

请仅对以上新固定证据做最终短答辩：是否认同本轮探针字幕问题已定位并修正、正常问答和转场回收可记隔离通过；剩下阻断应明确区分部署操作和未解决历史输入/性能问题。无需再重跑全历史或搜索新的宽泛反例。

补充性能口径：RTC_READY_PHASES.json显示普通轮worker_room_connected=6077ms，转场轮350ms；预构建分别2522/2575ms。但该探针是cargo test的debug产物、独立进程、Tokio两线程，而非线上release Worker。这只能作为下一步服务器链路分段定位线索，不能直接给生产性能定量、也不能把2.5秒预构建认定为现役根因。本轮目标验证不误关房及收包通路，未做性能达标。
