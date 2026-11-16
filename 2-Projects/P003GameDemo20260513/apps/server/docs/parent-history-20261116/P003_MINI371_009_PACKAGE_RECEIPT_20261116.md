# 371_mini_009 端侧真实业务记录 · 正式出包回执

日期：2026-11-16。结论：**开发、主机测试、正式签名构建与独立审包完成；按用户要求未上机、未操作服务器。真实三方验收 PENDING。**

## 1. 版本与文件

- 独立分支：`codex/g1-miniapp-ble-provisioning-20261028`；仅该分支推送，不合正式分支。
- 构建源：`006ac68a29447e8bc14fb655206d87bbf1f771a3`（包含主实现 `7021ce5`）。后续文档/派生证据提交不改变这个APK的产品输入。
- versionName：`371_mini_009`；versionCode：**371**；package：`com.futurus.p003.launcher`。不是主线正式版本或OTA占号。
- APK：`D:/P003交付/小程序BLE配网/371_mini_009/371_mini_009.apk`。
- 大小：**85,378,834** 字节；SHA256：`bde6b3eff817b10f3abd6e1f0b8f514ef17d44e0283829f9f0c608df9624d3db`。
- 干净构建产品源指纹：`e547054a58bd5b43ed2b93e8865534d796a228c889f5c74273c6eef9bdd11013`。
- 全量重建Rust、Godot base与原生payload，无旧APK/base复用；原正式入口退出0、`status=BUILT`、`source_stable=true`。
- 基础foundation PCK重新导出但字节未变：SHA256 `8ed5066137550ebdd894d1bb33e6caf6db8979d405aae04ec775a76775bea305`；**不用另更新PCK**。新增游戏逻辑在APK-owned资源中，不是“PCK没变所以功能没更新”。

## 2. 本轮完成

1. Runtime在真实业务原子提交时记录钱包收支、RewardLedger来源、补勤卡获得/消耗及物品获得/启用变化；和业务存档一起可靠落盘。
2. 旧档基线不算收入，normal/gm/unknown分开，真实发生时刻与游戏逻辑日分开；补播、重复点击不重复产生奖励收入。
3. Godot独立薄桥，原生SQLite持久成功才ACK Runtime；网络与业务ACK分离，精确ID/部分/重复/拒绝结算，冻结批次重启恢复、退避及凭据隔离。
4. 新候选网络合同 **p003-ark-records-r1默认关闭**，服务端回签并下发精确config后才上传；不是擅自在旧Telemetry/Ark严格Schema里加字段。
5. 原Telemetry、用时、Ark current、夜间Analytics、BLE协议/绑定、凭据恢复、MCU与美术/设备业务边界保留。新增模块及少量接线可独立移植。

服务端所需字段、ACK/重试、容量/覆盖/epoch限制、合并边界、建议汇总口径见 [端侧合同与合并说明](P003_ARK_RECORDS_CLIENT_R1_20261116.md)。[新增测试用例](P003_MINI009_TEST_CASES_20261116.md)及请求/响应Schema一起交付。

## 3. 实际测试和最终APK核验

| 检查 | 实际结果 |
| --- | --- |
| 精确干净提交canonical quick | Python **1254** 项、0失败、10条件跳过；源码/配置/405图片闭包PASS；架构仍是原精确5条债务，未扩大基线 |
| Rust完整回归 | **179** passed / 0 failed；含7项新事务/基线/幂等/持久失败/上限测试 |
| 原生完整JVM + lint/release | **1878** tests / 0 failure / 0 error / 0 skipped；其中新合同13、HTTP4；lint无Fatal/Error |
| 跨层主机验证 | 真实Rust→Godot→模拟native：buffered、离线、错save、外来/重复ID、不成功业务ACK均保留；正确partial durable ACK只删对应副本 |
| 最终签名APK真实导出验证 | 从该APK提取project.binary/GDC，配同源host Runtime执行上述交接，PASS；不是只跑源码或旧包 |
| 独立签名/对齐/DEX | 平台证书/ZIP对齐PASS；4 DEX / 16416类 / 0重复；41必需入口存在，新增Records类、桥接、config/lifecycle实际接入 |
| 非游戏/硬件边界 | 132非游戏资产与11无关native库字节保持；12库集合、MCU包/策略闭包通过；BLE 51原生方法、16诊断ABI一致 |
| 实际真机/云端/小程序 | **未执行、PENDING**；本轮明确禁止操作设备/服务端，不把JVM/SQL/主机模拟写成真机PASS |

保留原 `librknnrt.so` / `libopus.so` 的4KiB ELF段对齐债，不能把ZIP16KiB对齐宣称全部native库已满足16KiB。既有全场景UI/硬件验收未在本轮重跑，不声称可直接全量。

首轮干净quick发现诊断BUILD_LABEL遗漏008→009，修后新提交完整复跑通过，失败日志保留；开发镜像复制Windows CRLF的旧签名MCU测试夹具曾失败，恢复精确Git字节后完整通过，不修改固件安全策略或放宽断言。401暂停先持久化再调用通用恢复，防止恢复回调后又被旧响应暂停30分钟；新增回归守卫。

## 4. 构建与证据位置

门户本次实时仅允许正式分支、busy=false/queue0/active0，未提交mini job、不改白名单/借主线；保存明确分支拒绝证据后按已授权本地正式入口回退。

- 正式证据根：`D:/ChatGPTProjects/_codex-temp/p003-g1/mini371-009-20261116-attempt2/`。
- `PORTAL_DECISION.json`、`FROZEN_INPUTS.json`、`quick-clean/report.json`、`FORMAL_EXIT.json`、`build.log`。
- `EXPORTED_GAME_PROBE_RESULT.json` / `exported-game-probe.log`：最终APK实际GDC主机验证。
- `audit-attempt2/SIGNED_APK_STATIC_RECEIPT.json`、`INDEPENDENT_RESOURCE_AUDIT.json`、`INDEPENDENT_MCU_AUDIT.json`：独立静态审包。
- 开发定向及首轮失败保存在 `D:/ChatGPTProjects/_codex-temp/p003-g1/mini009-records-20261116/` 与 `mini371-009-20261116/`，不覆盖。

## 5. 服务端/小程序下一步与限制

- 先回签候选路径、字段、ACK、幂等与config；本轮没有实际调用新服务端端点或开启灰度开关。旧服务器能力不能当新记录接收已上线。
- 服务端实现记录接收、昨日收益/当前物品聚合与家长分页读取，小程序消费真实字段；任务/兑换/约定/KidsHub/报告等不是此次端侧补齐范围。
- 验证机保绑定与队列覆盖安装后，按用例真实逐ID对账；不清队列、不重绑来掩盖旧数据，不能把pending=0当完整历史。
- 当前保留用户原体验二维码，配置标注 **11月10日前有效**；本轮未获取新码、不改资源。若仍需首次扫码，须由小程序方提供有效入口；不能把过期码称可用。
- 容量与来源限制必须保留：Runtime2048条、原生20000行/正文8MiB；覆盖前历史未知、溢出显式dropped；缺epoch换凭据保守隔离，不自动把旧数据转交未知归属。
- 人工安装/真实BLE/Android SQLite电源中断、HTTP与服务器/手机一致性均待后续授权。没有上机或全量OTA操作。
