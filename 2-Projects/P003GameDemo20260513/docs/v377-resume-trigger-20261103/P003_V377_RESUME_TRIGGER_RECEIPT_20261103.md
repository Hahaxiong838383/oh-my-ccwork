# P003 v377 单机恢复补传：false→true 服务端回执

**受控切换已完成，当前已恢复 true，目标配置为 cfg-132。真实 HTTP 补传及客户端最终队列结算仍待对账，尚不宣布端到端通过。**

## 握手时间与版本（2026-11-03，北京时间 CST）

| 阶段 | 时间 | revision / 状态 | 证据来源 |
|---|---|---|---|
| 服务端下发 false | 13:29:55.203 | cfg-96，event_upload_enabled=false | 管理接口保存、公网配置回读、48独立只读核验 |
| 客户端应用 false | 13:35:38.739–13:35:38.744 | cfg-96，analytics_config enabled=false；期间无上传尝试 | 用户转述端侧确认，未冒充服务端独立设备日志 |
| 服务端恢复 true | **13:40:41.495** | **cfg-132，event_upload_enabled=true** | 管理接口保存、公网配置回读、48独立只读核验 |

管理策略 revision 为 **3**；它不同于设备配置 cfg-132。此次严格等待端侧确认 false 后才恢复 true，没有连续快速切换。

## 当前有效配置

- 目标 MCU / Device Bearer sub：末8位 **03800006**；有效上传范围仍仅该设备。
- `analytics.event_upload_enabled=true`、`daily_upload_hour_cst=23`。
- 按需 capture/upload、分层/聚合及 gzip 保持 true。
- request_id：`diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae`，没有换 ID 或清零已用额度。
- 截止：**2026-11-10 12:39:39.162 CST**；请求累计额度1000条，样本回看/保留3天。
- 接收器 ready / upload_allowed 均有效；源码、服务进程、Ark授权及倾听配置未改，无重启、故障注入或合成业务事件。
- 标准管理接口会刷新global/active设备的配置版本与更新时间（每次36行），其他设备的有效开关值与日批小时保持不变；唯一配置值变化是目标 event_upload_enabled。

## 端侧继续操作与回传

1. 确认真机实际应用 **cfg-132 / analytics_config enabled=true**，保留应用时间及 `config_enabled` / `drain_kind=resume` 等实际日志；不要仅凭服务端已保存判断端侧已应用。
2. 在客户端既有空闲安全条件满足后核对真实 HTTP 上传。忙态可能延后；不用改钟、清队列、反复切开关来催传。
3. 回传每次 HTTP RID（`ana-03800006-...`）、batch_id、HTTP状态、accepted / duplicated / rejected（含原因）及 pending；按同一RID对账。request_id在事件context中，与HTTP RID区分。
4. 将本次标为 **RESUME／恢复补传**，与正常23:00 DAILY分开。此前pending=250与新增29条本地accepted不等于云端accepted，也不能预先承诺250条全接收。

截至服务端只读查询 **13:41:52.208**，本窗口仍是0次HTTP attempt，无新ACK/入库样本。该结果仅记录查询时刻，不能认定补传失败或联合验收通过。收到端侧实际RID后，主13与会话48继续核对数据库/ACK/诊断usage；客户端最终pending须由端侧提供。

## 运行与回滚记录

false和true各自的操作前状态、实际回执、配置差异与端侧false确认已保存私有备份。若后续需暂停，通过当时最新管理策略revision关闭既有单机范围；保留诊断请求、队列、数据库与去重记录。当前没有安排再次自动切换。

本回执更新此前“等待cfg-96应用确认”的状态；一周窗口的时间与其他验收要求继续有效。

署名：codex（OpenAI）| 2026-11-03 CST
