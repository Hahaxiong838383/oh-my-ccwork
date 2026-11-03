# P003 G2 v377 埋点真机联调回执

## 结论

客户端真机埋点链路通过：配置切换、Godot 采集、Launcher durable 入队、白天 resume 补传、服务器 HTTP ACK、队列排空和日批语义均符合合同。

服务端仍需按下述 RID 做一次后台独立只读对账；本回执不把客户端 ACK 冒充后台查询证据。

## 测试范围

- 正式包：G2 v377，`versionName=1.2.2-canary.363`
- 客户端提交：`e863cf608cd1955b974687a05f8b5e5453f7dfb3`
- APK SHA256：`9eb9a16e9cfe19bae193ecc393ef977644369ca93119d97674cc5a52a5e48f12`
- 联调设备云端身份：仅记录末 8 位 `03800006`
- 按需 request_id：`diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae`
- 本轮只验埋点，不验方舟快照或倾听功能

## 配置切换证据

### false 阶段

```text
13:35:38.739  analytics_config enabled=false
13:35:38.741  analytics_disabled reason=config_disabled
13:35:38.741  device_runtime_config_cached revision=cfg-96
13:35:38.744  device.runtime_config_changed revision=cfg-96 event_upload_enabled=false
```

false 生效期间没有上传尝试。

### true 阶段

```text
13:41:51.558  analytics_config enabled=true
13:41:51.558  analytics_enabled reason=config_enabled
13:41:51.563  device.runtime_config_changed revision=cfg-132 event_upload_enabled=true
```

`cfg-132` 保留 23:00 日批、gzip、按需 request_id、一周窗口和额度。

## 本地采集与入队

本轮窗口内已确认按需样本使用正确 request_id：

```text
12:26:25  analytics.on_demand_sample accepted=26 rejected=0 pending=221
13:19:45  ordinary events accepted=22 rejected=0 pending=243
13:20:00  ordinary events accepted=7  rejected=0 pending=250
13:20:30  analytics.on_demand_sample accepted=6 rejected=0 pending=252
```

按需样本共 32 条；本轮恢复上传前 Launcher 总 pending 为 252。

## 网络上传与 ACK

```text
13:41:51.592  upload_attempt count=200 drain_kind=resume rid_suffix=ana-03800006-b760f4fa-9
13:41:52.389  batch_uploaded accepted=200 duplicated=0 rejected=0 pending=52

13:41:54.411  upload_attempt count=52 drain_kind=resume rid_suffix=ana-03800006-b760f4fa-10
13:41:54.716  batch_uploaded accepted=52 duplicated=0 rejected=0 pending=0

13:41:54.719  drain_complete batches=2 drain_kind=resume daily_marked=false
```

汇总：

- accepted：252
- duplicated：0
- rejected：0
- pending：0
- drain_kind：`resume`
- daily_marked：`false`

`daily_marked=false` 是正确结果：白天补传没有提前占用北京时间 23:00 正常日批名额。

## 健康与持久证据

- Launcher 进程持续存活；
- 六项核心服务 6/6 运行；
- 本轮未发现 Launcher Fatal/ANR；
- v377 受控日志出口再次成功导出 4 个最近日志文件；
- 持久 system 日志中完整保留 cfg-96、cfg-132、两次 RID、ACK 和 pending=0 证据；
- 未清 logcat、未清游戏存档、未修改设备时间、未改绑定或 Wi-Fi。

持久日志导出目录：

`D:\ChatGPTProjects\_codex-temp\p003-g2\v377-analytics-joint-20261103-122212\post-upload-export`

## 请服务端独立对账

请按以下条件只读核对：

- 云端身份末 8 位：`03800006`
- request_id：`diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae`
- HTTP RID 后缀：
  - `ana-03800006-b760f4fa-9`
  - `ana-03800006-b760f4fa-10`
- 时间窗口：北京时间 2026-11-03 13:41:51–13:41:55
- 客户端 ACK：accepted=252、duplicated=0、rejected=0
- 其中按需样本：32 条

服务端确认后台入库数量、按需额度使用量和拒绝明细一致后，本轮埋点联合验收即可完全收口。

署名：codex（OpenAI）｜2026-11-03 CST
