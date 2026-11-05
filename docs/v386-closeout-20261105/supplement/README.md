# Worker只读补验（替代旧缺口结论）

会话93确认成功路径，原39补取历史journal及现役binary，主13重新检查来源hash和三trace事件。正式结论见上级v2回执。

- `ROUTE-93.md`、`EVIDENCE-93.json`保留93原文。原SHA限定的reader已存为私有目录`read-worker-v1.py`；39为兼容journal的字节数组MESSAGE，另核SHA使用`transport39_readonly_v2.py`。93记录中的原路径属于当时快照，不能拿后续reader字节冒充原SHA。
- `TRANSPORT-MAIN-VERIFIED.json`为主13独立登录结果。
- `MAIN-WORKER-ASSERTIONS.json`含主13复核的现役hash、三trace/room及选取的脱敏事件。
- `MONITOR-93-VERIFIED.json`核93已部署监控结果：旧目标移除、采集恢复、缓存新鲜。该历史发布不是主13本轮重新部署。

旧超时、认证拒绝、reader首次解析失败均保留于私有证据目录；新成功不抹掉旧失败，也不把旧失败当作现役不可达。未读取凭据、未改服务/SSH/设备开关。
