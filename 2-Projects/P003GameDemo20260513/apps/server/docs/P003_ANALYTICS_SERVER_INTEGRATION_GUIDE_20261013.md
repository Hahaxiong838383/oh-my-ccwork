# P003 产品事件埋点：端侧联调说明

面向安卓/Godot端侧同事。固定输入：`ANALYTICS_SERVER_HANDOFF_20261009.md`、57事件清单、producer `daf7c17`（v321）。服务部署和实测结果以同目录部署回执为准。本次不改APK、不操作设备；首台真机和真实夜间上传仍待联合验收。

## 入口与凭据

正式入口：`POST https://kidshub-ai.hahaxiong.cc/v1/device/analytics/events:batch`。
沿用已有 **Device Bearer**（HS256、kind=p003-device）；请勿使用语音房间票据或运营后台token。设备身份从已验证凭据sub确定，正文不增加SN、昵称或身份字段。撤销/台账状态继续生效。

必需header：`Authorization: Bearer <已有设备凭据>`、`Content-Type: application/json`、`X-Request-Id: <本批技术标识>`。request_id会原样回显；仅1..96字符 `[A-Za-z0-9_.:-]+`，不trim/截断。不将凭据写入联调聊天、截图或日志。

## 配置与当前开关

完整设备配置快照保留原schema_version、revision、posture，并新增：

```json
{"analytics":{"event_upload_enabled":false,"daily_upload_hour_cst":0}}
```

这是服务器发布全局配置的analytics片段，**不是可以代替完整快照的响应**。端侧内置默认仍false/23点；服务器全局发布为false/0点（北京时间）。SN覆盖优先于全局，再回落内置；revision单调更新。小时合法值为0..23整数。

本次上线保持三重保护：服务器总闸关闭、独立灰度名单空、设备上传false。不要全量打开端侧上传。请先约定一台明确的非儿童在用测试机及测试时间，再由服务端加入独立名单、仅为该SN打开配置、热开总闸；其他设备保持关闭。现有设备接入准入名单不等于埋点灰度名单。

## 批次合同

外层仅schema_version、batch_id、sent_at_ms、client、events。每批1..200条；每条UTF-8 JSON≤8192字节；整个HTTP正文≤2097152字节。反向代理额外设3MiB硬顶，两层超限均返回JSON413。

client可包含product/component/protocol_version/content_version；当前producer的protocol_version为字符串`"1.0"`。它是**上传端元数据**，不得当作旧事件发生时的版本。context仅screen/phase/external_screen_connected。业务属性按57事件注册表及类型收窄，不上传自由文本、音频、转写、昵称、完整SN、token、坐标或网络秘密。

同一事件重试保持client_event_id与事件内容不变，可更换batch_id/request_id、上传时间和上传端版本。服务端以设备稳定内部键+事件ID摘要长期去重；JWT续签不会改变去重主体。

## ACK与错误处理

成功响应示例（技术标识仅为说明）：

```json
{
  "ok":true,
  "request_id":"integration-request-001",
  "accepted_event_ids":["integration-event-001"],
  "duplicated_event_ids":["integration-event-002"],
  "rejected":[{"client_event_id":"integration-event-003","reason":"event_not_allowed"}],
  "retry_after_ms":0
}
```

每个输入去重ID恰好落入三类之一，集合完整且互斥。accepted在数据库事务提交后才回；duplicated表示既有相同内容，不重复贡献报表。同批同ID同内容只结算一次，内容不同则整个ID拒收；跨批改写旧ID也拒收。服务端不会修改旧事件覆盖历史。

| HTTP/受控码 | 端侧处理 |
|---|---|
| 200 accepted / duplicated | 按现有客户端ACK逻辑结算对应ID；重放不会重复入库 |
| 200 rejected | 对该ID终态处理，不拖住同批正常事件；保留端侧deadletter审计 |
| 400 INVALID_REQUEST_ID / INVALID_JSON / INVALID_BATCH | 修正整批结构；不要当成功或无止境原样重试 |
| 401 INVALID_DEVICE_CREDENTIAL | 走现有凭据续签/重取路径，不使用语音房间票据代替 |
| 403 ANALYTICS_DEVICE_NOT_ENABLED | 暂停上传，核对独立灰度名单及台账active状态 |
| 413 ANALYTICS_BODY_TOO_LARGE 或代理ANALYTICS_BATCH_TOO_LARGE | JSON错误；需要端侧拆批，不能将整批当ACK排空 |
| 429 ANALYTICS_RATE_LIMITED | 数字秒Retry-After，退避后重试同一批；默认每主体60rpm/全局600rpm |
| 503 ANALYTICS_UPLOAD_DISABLED | Retry-After=900秒，暂停；关闭/回滚不会返回404或HTML导致误入deadletter |
| 503 OVERLOADED/STORAGE/DEPENDENCY/DISK/MEMORY相关受控码 | 遵守数字秒Retry-After；无成功ACK不删除pending，后续重试 |

逐事件rejected原因：event_not_allowed、event_too_large、invalid_event、invalid_context、invalid_properties、client_event_id_conflict。深层非法结构也给该ID终态拒收，不把正常同批事件拖成永久503。`properties:{"truncated":true}`是端侧超限退化的显式兼容分支。

## 首台联合验收顺序

1. 同事确认测试APK/Launcher版本、测试机、联网和本地pending/confirmed/deadletter基线。服务器保持总闸关闭时，验证完整配置含analytics，上传关闭且原posture未丢失。
2. 约定测试机后，服务端仅对该机设置灰度与upload=true，打开总闸。确认配置revision刷新、生效小时0，其他设备仍false。
3. 发送正常/未知事件/单事件超限混合批，核对完整互斥ACK与端侧本地结算；在后台“Worker管理→数据埋点”按request_id和client_event_id对账。
4. 丢失响应后重发同ID，正常得到duplicated；续签设备JWT后再重放，仍去重。验证网络暂断、401续签、429/503数字退避与恢复后自动续传，无需强制flush。
5. 回滚演练只关闭总闸/设备upload，确认503/900且pending不丢；再开时原已接收ID仍duplicated。
6. 北京时间00点夜间真实验收：前台/语音忙/OTA或配网时延后，闲时补传。核对当日已确认事件、剩余pending、deadletter及服务端received窗口与发生日窗口。等汇总任务刷新后再对账日报。
7. 报告上述真机与夜间结果后再决定扩灰；这两项尚未在服务器发布验收中完成，不能因后台事件为0就判定端侧不活跃。

端侧当前实现30轮是单次上传循环上限，约每批200条/间隔2秒；不把6000条当整个夜间硬上限。旧pending可能在白天配置生效后立即补传，首台测试时须先掌握本地积压。

## 端侧需要特别核实的两点

- Godot失败重试路径静态检查发现 `_failed_flush`返回epoch的retry_at_ms，而main调度可能比较ticks_msec；请验证“局部上传失败一次→恢复→自动重试”确实发生，不以手工强制flush掩盖。这里是待验证疑点，不是已复现根因。
- semantic_interaction 的source/day_index/reward_kind/page/direction目前源码未见实际发送实例，服务端采用已记录的收窄类型（day_index整数，其余字符串）。若实际发送不同类型，请给脱敏最小样例同步合同；57例测试是源码推导样例，不是假称本次真机捕获。

## 后台口径与保留

仅原运营后台admin可读取；editor/guest403，未登录401。新增五tab：概览、上传批次、事件对账、57目录、采集配置。配置页只读，编辑沿用原设备配置入口。

设备仅显示稳定短别名。pending未知须端侧本地审计补充；设备数量不是孩子人数，语音状态事件不是逐轮回复率，按钮点击不是奖励结算，流程计数不是严格序列漏斗。没有收到批次也不能推出没有活跃。

原始事件/批次回执保留14天（接收时间），日报与最小聚合事实保留90天；内测去重摘要不自动清。最小事实不含context/properties原文，保证14天原始数据过期后，迟到数据仍能正确重建历史日报。语音间歇不回复仍按原约定等自然复现，不用此埋点推断根因。

更多精确字段见 [服务端合同](analytics-server-contract-v1.md)、[后台API合同](analytics-admin-api-v1.md)。发布信息见 [部署回执](P003_ANALYTICS_SERVER_DEPLOY_RECEIPT_20261013.md)，运维回退见 [回滚记录](P003_ANALYTICS_ROLLBACK_20261013.md)。

署名：codex（OpenAI）| 2026-10-13
