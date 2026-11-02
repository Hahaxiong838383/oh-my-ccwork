# P003 v375 服务端已部署｜单机联调回执与测试用例

**服务端已上线，单机联调已开，可直接开始设备侧验证。云端配置已保存并通过公网回读，真实设备收到配置、实际上传与对账尚未验收。**

| 项目 | 实际状态 |
|---|---|
| 目标设备 | `BJP00326070803800006`，须与 MCU SN / Device Bearer sub 完全一致 |
| 客户端 | 同事交付 v375 / 1.2.2-canary.361；源码 `52b89ec9a4823eb62b424f094d613b4a09a10708`，交付 `4f7cc36668be6f9c676825d3be929f72447e9c0b` |
| APK SHA-256 | `5c55524e0ea9ae0489d3e57c98272f3d9cea8807903986fd6705953dfa06b87c`（来源：端侧交付回执，本轮未重装） |
| 服务端运行候选 | `856552b942f5f8c2feb08db5949ebe7080eff77f`，2026-11-02 21:56:01 CST 完成增量部署 |
| 地址 | `https://kidshub-ai.hahaxiong.cc`，沿用现有 Device Bearer，不发送凭据 |
| 接口 | GET `/v1/device/config`；POST `/v1/device/analytics/events:batch` |
| 上传范围 / 时间 | 总闸已开，仅上述设备；`event_upload_enabled=true`，`daily_upload_hour_cst=23`。其他设备关闭 |
| 云端配置 | **`cfg-61`**，22:00:23 CST 公网独立回读一致 |
| 请求 RID | 继续 `ana-03800006-` 前缀 |
| 按需请求开始 | **2026-11-02 22:00:23.878 CST** |
| 按需请求到期 | **2026-11-03 00:29:59.878 CST**（约 11 月 3 日 00:30） |
| 按需 request ID | `diag-15f09d45-9c84-4fa9-8937-fae9509152b8`；写在事件 **context.request_id**，与 HTTP RID 不同 |
| 额度与范围 | 本请求最多新 accepted **100 条样本**、最大回溯 3 天；允许合同全部 14 个脱敏来源，不代表一定有 3 天历史样本 |

## 已下发的配置

```json
{
  "event_upload_enabled": true,
  "daily_upload_hour_cst": 23,
  "tiering_enabled": true,
  "aggregate_upload_enabled": true,
  "aggregate_period_days": 7,
  "aggregate_retention_days": 90,
  "aggregate_max_buckets": 2048,
  "on_demand_capture_enabled": true,
  "on_demand_upload_enabled": true,
  "on_demand_request_id": "diag-15f09d45-9c84-4fa9-8937-fae9509152b8",
  "on_demand_retention_days": 3,
  "on_demand_max_events": 1000,
  "on_demand_max_bytes": 2097152,
  "request_gzip_enabled": true
}
```

云端保存顺序为 gzip `cfg-56` → 分层双真 `cfg-58` → 按需请求 `cfg-61`。设备可能一次拉到最终 `cfg-61`，这不代表 gzip 单独真机 A/B 已通过。请记录 Launcher 和运行中 Godot/PCK 实际应用时间；APK 已安装不等于运行 PCK 已具备分层能力。

**普通 append 只入持久队列，创建请求不会触发立即联网。** 保持 23 点日批，已有补传/恢复逻辑也可能提前上传；不要修改设备时间、切总上传开关或改小时来强制排空。未收到配置时先确认原有启动/网络恢复/30 分钟轮询，不必重装或清队列。

## 端侧按此测试并回传

| 编号 | 动作 | 通过证据 |
|---|---|---|
| T1 身份与配置 | 核完整 SN、APK、运行 PCK、设备北京时间；记录配置应用 | Launcher/Godot 均收到 `cfg-61` 与上述值；不发送 Bearer/密钥 |
| T2 真实本地分层 | 正常开关设置页、切换页面、使用设备 | 两开关同时真；成功高频事件进入本地桶，关键失败/奖励/钱包事件仍按原 raw 处理；记录来源、桶 count 和边界 |
| T3 今晚 gzip 与样本 | 22:58 开始抓脱敏日志；保持联网，等待 23 点日批；23:10 首轮核验 | 原 RID、batch_id、Content-Encoding、wire/inflated 字节、三类 ACK 与 pending/死信统计；服务端按同 RID 查真实批次、压缩统计及样本层 |
| T4 配额与旧队列 | 正常交付已排队的数据，不做故障注入、不清队列 | raw 与诊断分开结算；100 是样本 accepted 总额度，dup 不占，超限可逐条拒收；不能把预期样本额度拒收当 raw 丢失 |
| T5 周期聚合 | 保持真实时钟，等本地桶闭合再按日批交付 | `period_end_ms <= 服务端接收时间`；同 ID 首次 accepted、已收重放 dup；当前未闭合桶不应发 |
| T6 原功能 | 日常唤醒、短对话、倾听故事、搜索天气、方舟进度问答 | 无新异常；方舟使用权威快照/原始关键事实，聚合 count 或诊断样本不能充当余额/收益 |
| T7 到期 | 约 00:30 后核下次配置拉取及队列结算 | 请求到期后新样本逐条拒收，已接受样本重放仍 dup；下次设备/后台 GET 清 upload=false、request_id 空并升 revision；raw 日批继续 |

允许的 14 类：`app.lifecycle_changed`、`g1.screen_viewed`、`g1.semantic_interaction`、`g1.runtime_command_completed`、`g1.progress_checkpoint`、`settings.opened`、`settings.closed`、`settings.page_viewed`、`settings.value_changed`、`network.connectivity_changed`、`network.provisioning_state_changed`、`voice.session_state_changed`、`app.bridge_ready`、`g1.route_state_loaded`。成功条件、字段校验和脱敏约束均仍生效。

固定 7 天周期按 Unix epoch 对齐 CST 整日，不是从启用时或周一开始。本次所在周期为 10 月 29 日 00:00～11 月 5 日 00:00；首个闭合桶通常等 **11 月 5 日 23 点日批**，以端侧真实桶边界与调度为准。今晚没有聚合到账不代表失败，完整 7 天节省率仍待观测。

按需到期只终止该请求的上传授权；**不自动关闭本地 capture**，本地缓存继续受 3 天 / 1000 条 / 2 MiB 限制。配置清理由 GET 触发，没有 00:30 瞬间推送定时器。需完全停采时在后台显式关闭 capture；已经交给 Launcher 的样本不会自动撤回。设备离线错过窗口时，不自动延长，回传实际时间再安排。

## 服务端已验证与未验证

- 已验证：45 固定候选独立 HTTP 8/8、分层/Ark 12/12，Ark 51/51、配置 36/36、倾听 7 脚本、生产 Vue 的隔离 WebKit 45 项；F45-01 未闭合周期修复及边界通过。
- 已上线验证：21 个文件 SHA 一致，311 个既有/新增源码文件无意外漂移；公网 gzip 空信封和 identity 均 `400 INVALID_BATCH`，wire/膨胀超限均 JSON 413，未认证 401；探针没有写入任何批次/虚构事件。空信封探针不是完整上传成功证据。
- 服务健康：ready=true，storage_failures=0，sql_busy=0；原上传策略单038/23点、倾听 rev6/ACK6 与搜索/Ark配置保持，其他设备未增开。容量上限仍 4 台，不因合成压缩结果上调。
- 当前 22:02 快照：新 tier 与 transport 行均为 0，真实 v375 日批/PCK 分层仍待端侧；原 Ark 快照接口可读，不能代替真人问答验收。
- 尚未验证：真实设备应用、gzip/样本/聚合入库对账、真人语音与负载、7 天实际节省率。本轮无法新开线上浏览器，已核公网后台 HTML 精确 SHA 及真实管理 API；隔离 UI 验证不冒充线上操作。
- 全仓 TypeScript 仍有 12 项原基线错误，候选与基线输出一致，不声明全仓类型检查通过。

后台入口：管理后台 → **数据埋点 → 分层与按需** → 选完整目标 SN，可查配置、请求期限/额度、分层/压缩统计及最近记录。服务器仅接收完成周期；原始正文、录音和凭据不要贴到回执。

## 回传模板

```text
北京时间 / 完整SN：
APK / 运行PCK / 设备时钟：
配置revision / Launcher与Godot应用时间：
阶段（本地桶、gzip、样本、闭合聚合）：
HTTP RID / batch_id / client_event_id：
按需context.request_id（如有）：
Content-Encoding / wire与inflated字节：
accepted / duplicated / rejected及reason：
pending前后 / 死信reason与数量：
聚合period_start/end/count（如有）：
普通语音、倾听、搜索、方舟问答结果：
结论（已验证 / 部分验证 / 待验证）：
```

请把上述 ID 与数量回传主会话13，服务端按同一批次补齐持久化/三分区 ACK/后台查询对账。今晚只验正常真实链路，不做故障注入或改其他设备。

署名：codex（OpenAI）| 2026-11-02 CST
