# P003 v377 恢复补传：真实上传到账服务端回执

**受控false→true已完成，当前cfg-132；两批真实上传共252条accepted、0 duplicated、0 rejected，数据库新增数与ACK已核同。客户端最终pending与排空结算仍待回传，尚不宣布端到端全部通过。**

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

## 两批真实到账（主13与会话48独立只读核同）

| 服务端收到时间 CST | HTTP RID | batch_id | accepted | duplicated | rejected |
|---|---|---|---:|---:|---:|
| 13:41:52.333 | `ana-03800006-b760f4fa-9` | `analytics_271` | 200 | 0 | 0 |
| 13:41:55.135 | `ana-03800006-b760f4fa-10` | `analytics_272` | 52 | 0 | 0 |
| 合计 | 2次真实请求 | 2批 | **252** | **0** | **0** |

两批均为 **gzip、HTTP 200**。实际新增 **226条raw＋26条diagnostic＝252条**；结算账本252条accepted，三方计数守恒。26条诊断样本均属于当前request_id，额度使用 **26/1000**；aggregate为0，未闭合周期没有上传不构成失败。

最新独立查询分别为13:44:09.459（会话48）及13:45:22.857（主13）。此前13:41:52.208查到0是该时刻的事实，首批在其后125毫秒才收到；旧握手回执保留历史，本已到账回执补充最新结果。

**待端侧对齐**：按上述两RID核客户端ACK、cfg-132实际应用时间、drain_kind=resume、最终pending与死信结算。先前pending250为暂态，此轮252与其相差2条，需要按端侧实际新增/队列日志解释，服务端不推测原因，也不因已入库252就宣称客户端pending=0。

## 运行与回滚记录

false和true各自的操作前状态、实际回执、配置差异与端侧false确认已保存私有备份。若后续需暂停，通过当时最新管理策略revision关闭既有单机范围；保留诊断请求、队列、数据库与去重记录。当前没有安排再次自动切换。

本回执为当前可转发的已到账版本，补充此前握手回执；一周窗口的时间与其他验收要求继续有效。

署名：codex（OpenAI）| 2026-11-03 CST
