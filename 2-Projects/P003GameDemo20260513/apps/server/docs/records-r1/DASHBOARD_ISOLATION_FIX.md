# R1记录查询故障隔离

主13在a4a9ec82上继续。新增真实HTTP+SQLite故障测试先红：将临时库ark_record改名后，旧dashboard503而预期200。修复仅records-service包裹记录查询，返回空覆盖/不可用摘要dependency_unavailable。未改变旧Ark/Telemetry查询、钱包或授权。

验收：同一SQL故障下原ark/usage/device/today/week逐字段等于原响应；记录分页和上传仍503且无ACK，错误家长404，恢复表后原记录仍在且可重试成功。旧ark_current故障仍503，避免吞掉原功能错误。schema增加新reason。

首次全套31/32：新增fixture挤满原Ark32台授权上限，末例invalid_scope。仅给新增临时fixture加结束清理，未调生产上限；再次全套32/32通过。日志保留红、第一次绿失败、最终绿。此前127/59属于fe76919c证据，不能冒充新候选已复跑。

下一步：固定提交Grok复审、现役Node22 Linux隔离回归、最新六文件和依赖SHA/实际配置复核、受控单C发布准备。未修改生产。

署名：codex（OpenAI）｜2026-11-16
