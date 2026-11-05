# v386 倾听与方舟快照收口

- [可转发统一收口回执](P003_V386_LISTENING_ARK_CLOSEOUT_RECEIPT_20261105.md)
- [端侧原始回执](P003_G2_V386_LISTENING_PREPARING_IDLE_RACE_FIX_AND_DEVICE_ACCEPTANCE_20261105.md)
- [38 Brain](reviews/CLOSEOUT-38.md) / [39 Worker](reviews/CLOSEOUT-39.md) / [45 Ark](reviews/CLOSEOUT-45.md)
- [证据与提交索引](CLOSEOUT_INDEX.json)
- [11月4日发布/回滚](../v384-voice-20261104/ROLLBACK.md)

本轮采纳用户现场验收并独立核Brain历史权威、正常Ark最新快照与现役四文件；没有新增业务代码或发布。v2已复用会话93的Air认证/home TCP转发路径，补齐Worker历史journal与现役binary核验。旧路径失败不能概括为Worker不可达；一次未匹配session超时仍保留，不能把文档收口推成所有语音可靠性已解决。H1用途拆句保留此前服务端修复/隔离测试证据，本附件没有新增该场景真机trace。

审核原文按各自固定文档提交逐字节归档。38原报告“当前只读配置与版本（16:44–16:45 CST）”为时区文字笔误：EVIDENCE-38的09:44Z实际是17:44 CST，统一回执采用正确时间；未改原审核签名或JSON。主13已向原38反馈该文案更正。所有原始只读取证和执行失败记录位于`/Users/fu-121/.local/state/p003-v386-closeout-20261105/`，仓内只存安全摘要/索引，不入库完整原始用户内容。

经验：倾听close是模式授权关闭，不能当作房间已删除；配置snapshot握手不能当作Ark游戏快照；合法0不能等同于unknown；精确源码、Android回执、服务端持久记录和实时运行产物各有证据范围。用户已验收的定向用例不为了补文档重复全量测试。

## 2026-11-05 v2补验

- [SSH路径差异与93复验](supplement/ROUTE-93.md)
- [主13独立Worker断言与脱敏事件](supplement/MAIN-WORKER-ASSERTIONS.json)
- [93历史监控发布证据复核](supplement/MONITOR-93-VERIFIED.json)
- [原v1回执（历史，不作当前状态）](history/P003_V386_LISTENING_ARK_CLOSEOUT_RECEIPT_20261105_v1.md)

经验补充：经过相同跳板不代表认证身份相同；必须复用真正成功的调用链，区分网络连接、SSH认证、监控采集超时与Worker业务健康。v1遗漏93已完成修复，主13据此纠正并完成补验。

- [39 Worker补验回执](supplement/WORKER-SUPPLEMENT-39.md)与[补验JSON](supplement/WORKER-SUPPLEMENT-39.json)。顶层`MAIN-*`和`reviews/`为v1阶段原始证据，保留当时失败；最新Worker状态以本补验及更新索引为准。
