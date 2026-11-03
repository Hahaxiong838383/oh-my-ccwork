# P003 v377 埋点与方舟联合联调：服务端开窗回执

结论：**服务器窗口已开，仅设备尾号 03800006；可以开始配置应用、真实采样与快照链路测试。联合验收尚未通过。** 附件指定的客户端源码存在两项限制，见下文，不能按“开启后必然立即上传、钱包修复已入包”执行。

## 1. 实际窗口与配置

| 项目 | 线上核验结果 |
|---|---|
| 日期与时区 | 2026-11-03，北京时间 CST / UTC+8 |
| 实际开始 | 12:25:50.775 |
| 实际截止 | 23:29:59.775（延长以覆盖 23:00 日批） |
| 云端 MCU / Device Bearer sub | 末 8 位 03800006，沿用既有完整身份；不用 USB/ADB 序列号 |
| 配置 revision | `cfg-66`，公网设备配置接口已回读核同；尚未证明真机应用 |
| Analytics 总闸与范围 | 开启，仅该设备；其他设备不变 |
| `analytics.event_upload_enabled` | `true` |
| `analytics.daily_upload_hour_cst` | `23`，未修改 |
| 分层、聚合、gzip | `tiering_enabled=true`、`aggregate_upload_enabled=true`、`request_gzip_enabled=true` |
| 按需采样、上传 | `on_demand_capture_enabled=true`、`on_demand_upload_enabled=true` |
| 按需 request_id | `diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae` |
| 请求额度 | 最多接受 1000 条新样本，回看 3 天；14 类既有脱敏事件源 |
| 本地采样缓存配置 | 3 天、1000 条、2 MiB；请求配额与本地缓存不是同一统计口径 |
| 服务端接收能力 | runtime_ready=true、upload_allowed=true |

请求到期后，服务端拒绝该请求的新诊断样本；配置读取时清理过期上传标志与 request_id。**正常 23:00 日批继续开启**，有限本地采样缓存保持原配置，不把本次窗口结束当成关闭全部埋点。旧数据、去重记录、方舟数据保留。

## 2. 即时上传限制与可执行路径

已核附件精确源码 `35502e7746eed6b5f24e5ba1cfa7d7e263c68a72`：Godot flush 是向 Launcher 持久队列交接，`network_upload_scheduled=false`；新诊断 ID 本身不触发网络上传。

- **默认路径**：白天取得 cfg-66、产生真实事件并确认入队，设备保持联网空闲，23:00 起按既有日批策略上传；23:10 对账。窗口已延长，不会在 15:00 提前过期。若因设备忙/离线延后超过截止，先报告，禁止把过期拒收当作原正常链路成功。
- **白天需要提前对账时**：先回传“cfg-66 已应用、目标样本已进入 Launcher 持久队列、设备空闲”；服务端与现场随后配合一次**仅目标设备**的 false→true。必须先有客户端实际收到并持久记录 false 的证据，再开启 true，不能连续快速切换代替。该轮标记 `RESUME`（恢复补传），不是即时按需网络，更不是 23:00 日批。**当前尚未执行这一切换**。
- 单纯重启或保数据覆盖安装不保证触发；配对、语音、提示音、OTA/待重启等忙态会延后上传。不要清队列、改系统时间、制造鉴权错误来催上传。
- 聚合只接收已闭合的 7 天周期。本轮无需为了获得聚合结果而造数据或改钟。

## 3. 方舟授权与客户端版本差异

| 项目 | 只读核验结果 |
|---|---|
| `POST /v1/device/ark/state` | 当前目标授权有效 |
| Ark master / 设置 revision | true / 3 |
| 身份 epoch / grant epoch | 3 / 3，账号归属匹配 |
| 授权水位 `not_before_ms` | `1793609324433`，即 2026-11-02 16:48:44.433 CST |
| 授权操作 | 本轮没有重授、重置 epoch、修改存档或奖励 |
| 开窗前最新快照 | 12:24:50.338 收到 `ark-c89d8f6b7edd4e3c-407`，source_mode=gm，不能充当 normal 验收 |

**附件指定的 v377 源码尚未包含钱包修复。** 独立按 exact-ref 获取并核验 blob SHA 后，`rust_runtime/src/g1_ark_state.rs`、`rust_runtime/src/lib.rs`、`rust_runtime/src/g1/model.rs` 与未修复 v376 完全相同；钱包缺键仍由 `.get(...).copied()` 投影为 null。

因此该包可验证授权、传输、日志导出与未知值诚实回答；**不能据此验收“UI 为 0，上传也应为 0”的修复**。如果安卓已有更新提交，请提供实际合入钱包修复的固定源码、正式 APK SHA-256/字节数、运行内容/PCK 版本及真机安装证据，按实际包重新核验。此前钱包修复包已交付，勿在服务端用 null→0 兜底，也勿把 GM 改标为 normal。

## 4. 本轮测试与回传

1. 核对正式 APK、versionCode/versionName、内容/PCK 版本与配置 cfg-66；覆盖安装保留绑定、Wi-Fi、凭据、存档和队列。
2. 产生普通真实交互，记录样本交接与 pending；按第 2 节选默认日批或协调 RESUME。
3. 回传 `ana-03800006-` HTTP RID、batch、accepted/duplicated/rejected/pending 与请求时间。诊断 request_id 在事件 **context.request_id**，与 HTTP RID 分开；同样本重放不重复计数。
4. 上传 Runtime 权威 normal 快照，记录 snapshot_id、boot_id、sequence、captured_at_ms、HTTP 状态、服务端 received_at_ms；GM/unknown 单独列明，禁止清档制造 normal。
5. 同轮做服务端预览与真机问答：家族币、星尘、补勤卡、下一奖励/剩余时间/进度。以同一快照对账；缺失值保持未知。语音实际听到的回答单独取证，预览成功不替代真人问答通过。
6. 回传受控导出日志的文件名、字节数与 SHA；不发送凭据、原始用户正文、完整 USB/ADB 身份。按需样本、RESUME/CATCHUP、23:00 DAILY 分开记账。

## 5. 协作与回滚

- 会话 48：埋点合同、配置回读、RID/ACK/持久化/分层额度对账。
- 会话 45：钱包修复源码、Ark 授权/normal 快照/预览与问答对账。
- 主会话 13：唯一生产配置写入、跨链验收与最终回执。两会话复用原分支/工作树，当前运行模型均为 gpt-6-astra，full access 已核。
- 本轮仅新建目标诊断请求；无代码部署、无服务重启、无故障注入。其他设备配置、正常日批策略、Ark grants、主服务源码与进程、倾听发布清单逐项核同。
- 精确撤销：管理员撤销本 request_id 即可，使按需上传 false/ID 清空；保留正常上传与日批，不回灌数据库。操作前后配置及实际回执已留服务器私有备份。

当前未验：真机实际包与 cfg-66 应用、此次请求实际样本到账、修后 normal 钱包、同轮真人问答、今晚日批。**服务端开窗完成，不等于端到端通过。**

署名：codex（OpenAI）| 2026-11-03 CST
