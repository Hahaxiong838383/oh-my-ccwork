# 坐姿提醒次数接入 · 2026-11-17

本次更新当前仓 RealDataHome 参考实现和 Worker 小程序 Dashboard。现场回执所称 liveHomeView 不在此工作树；构建完成不代表现役微信小程序已发布。上传仍使用原 Telemetry 接口、事件ID和逐ID ACK，无需新传累计次数字段。

## 查询字段

家长仍请求 `GET /v1/parent/devices/:public_id/dashboard`，后台读取同一数据域。两端统一消费 `data.posture_reminders`，不从检测轮次、使用时长、设备在线或快照时间推算计数。

| 原始 JSON 路径 | 展示规则 |
|---|---|
| `source / timezone` | `telemetry.posture_reminder / Asia/Shanghai` |
| `today.date / available / played_count` | 今日日期及已同步提醒次数；available=true 且 count 非null才展示数字，合法0显示0次。 |
| `history.available / played_count / from_day / to_day` | 历史已同步提醒次数和已收到事件的发生日期范围；不称完整历史总数。 |
| `today.updated_at_ms / history.updated_at_ms` | 提醒数据接收更新时间；独立于设备快照/心跳时间。 |
| `today.suppressed_count / unknown_count` | 冷却拦截次数、未知结果条数，分开提示，不能加进played。 |
| `daily` | 有提醒事件的历史日期行；缺失日期不自动补0。 |
| `coverage.complete` | 固定false，仅代表已收到的部分事件。 |
| `coverage.clock_suspect_count` | 时间有疑点的记录，仍按上报发生日期统计并提示日期待核。 |
| `coverage.invalid_time_count` | 时间非法而无法归日的记录，不计入按日次数；不能把此情况当0次。 |

`no_reminder_events` 表示该范围未收到提醒事件；`no_supported_outcome` 表示仅有未知结果；`invalid_event_time` 表示收到提醒但时间全无效；`dependency_unavailable` 表示读取失败。以上状态不以旧 `today.posture_alert_count` 的默认0覆盖。

本仓传输层自动 snakeToCamel，组件使用 `postureReminders.today.playedCount` 等camelCase；直接消费原始JSON的现役页面按表中snake_case读取。

## 计数与刷新

只有 `posture_reminder` 且 `data.outcome=played` 的独立事件计1，表示调整坐姿语音已开始播放，不代表播放完成、孩子听完或随后坐正。focus_id=null合法；重复上报/重复ACK不增计。冷却拦截、检测deviated、无人、心跳及未知outcome不计提醒。

补传按原 `occurred_at_ms` 的北京时间自然日归属，不挪到补传当天，也不用游戏逻辑日。纯事件请求即使 snapshot=null，两端仍显示已入库提醒。点击刷新会重新读取dashboard，服务端没有新事件时保持相同数值，不自行递增。

当前仓的登录、切设备、退出、迟到响应失效逻辑保持不变；卡片与最新设备快照可用性分离。现役手机版本需按上述读取映射接入后再真机核对，不能把参考H5验证当微信手机发布证据。

署名：codex（OpenAI）| 2026-11-17
