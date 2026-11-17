# 24小时混合调度准备

仅测试编排；业务src保持b1ce23不变。资源统计口径固定13b62db9的保守工作集，正式结果需Linux实测，不用Mac模拟计数冒充。

- T5_SOAK=1仅接受50×6000、200条/批、日批1h截止、已核候选Ark与统计前缀索引、真实维护与备份。单调钟运行至少86400000ms；CST23:00只发一次日批。
- 50身份每50秒真实HTTP写入不同签名快照，未知星尘保持null；客户端日批不重写同一Ark序列。沿用真实writer/checkpointer/ledger/ArkStore/导出/Backup API；不新增产品服务或timer。
- 每5分钟维护、导出；日批启动后调用现备份器，只有实际published且真实开始/结束区间与日批相交才算备份重叠。not_due/waiting不算完成备份。
- 停止生产后最多监督1h排空，要求实际NAS收据、全部source batch记录数等于接受数，pending0；最终仍须外部独立核NAS全payload，脚本不能签发full T5。
- 完整资源原始样本每5s，结束补采，CPU配额、host可用内存、工作集、OOM、PID、磁盘和24h门不降。Mac smoke明确full_day_requested=false/resource_gate=false；正常旧压测模式另跑回归。
- 独立新spool、独立NAS测试接收目录与受限SSH key，不能复用旧spool的当日ACK造成not_due假绿。开跑前先核有限测试存储预算、额外备份峰值、生产ready保护；未归档旧失败夹具不能直接删。
- 当前只是调度smoke通过，真实24h未启动；成熟44.87GB库、完整72h积压排空、语音AB另有门，不能被fresh长稳替代。

回滚只撤销测试编排提交，不触生产。署名：codex（OpenAI）｜2026-11-18

更新：ec6e3f75不能直接签发24h开跑，Grok408的定时相位项已按实际首ACK触发修正；新增实际Ark历史查询覆盖。正式24h要求≥10000次查询、跨越至少23h50m、周期缺口≤10m、零事实/传输错误、总P99≤100ms。每轮先执行现役Brain startup warmup并记录，不拿设备查询预热后丢弃。修正后的固定SHA仍需独立复核和Linux运行验证。
