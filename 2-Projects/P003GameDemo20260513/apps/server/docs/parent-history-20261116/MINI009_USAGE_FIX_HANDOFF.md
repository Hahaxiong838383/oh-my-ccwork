# mini009 基线使用时长修复交付（后继候选暂拟 mini010）

**结果：精确 mini009 源码已应用最小开盖修复，保留其全部 R1 实现；本包是源补丁与证据，不含 APK，未安装、未 OTA。后续应以本包取代 mini008 补丁作为新候选基线。** 原 mini008 补丁包保持冻结，仅作根因和回归对照，不应用它重建一个会丢失 mini009 新能力的包。

## 1. 更晚的端侧证据

2026-11-16 本轮通过 Android 仓原 origin 只读查询并精确取得：

- 最新回执提交 `75378716195bda8e7414af97ffd8dbd0b109212b`，提交时间 **2026-11-16 21:22:05 +0800**，标题 `docs(miniapp): deliver mini009 package evidence and server handoff cases`。
- mini009 实际构建源 **`006ac68a29447e8bc14fb655206d87bbf1f771a3`**。本修复独立树从该提交创建，没有合入主线，也未覆盖原工作树。
- mini009 原 APK 声明：`371_mini_009 / code 371`，85,378,834 bytes，SHA256 `bde6b3eff817b10f3abd6e1f0b8f514ef17d44e0283829f9f0c608df9624d3db`，Windows 文件 `D:/P003交付/小程序BLE配网/371_mini_009/371_mini_009.apk`。
- 原回执宣告开发、主机测试、签名构建与独立审包完成，**明确未上机、未操作服务器，真实三方验收 PENDING**。这是远端 Git 中已交付的构建回执；本机尚未取到该 APK 做独立字节复核。
- 因而此前“18:08 端侧尚未实现”的需求回执已被该新证据取代，不能再称它是最新端侧状态。

原回执、R1 合同及测试用例已按精确回执提交原字节随包附上：`P003_MINI371_009_PACKAGE_RECEIPT_20261116.md`、`P003_ARK_RECORDS_CLIENT_R1_20261116.md`、`P003_MINI009_TEST_CASES_20261116.md`。其主机 PASS 不能继承为本次修复包或现场 PASS。

## 2. mini009 仍有开盖枚举错误，本次修复范围

mini009 的 `P003TelemetryCoordinator.kt` 与精确 mini008 的该文件逐字节一致，SHA256 均为 `8fdafc52c8b2fa67d7b89588531238bf8f64523b139752b7c13ac89ee6215df6`：`:575` 比较原始 workState/Hall1，`:625–626` 私有常量却为 `1/1`。同源 `WelcomePolicy.kt:122–124` 使用活动4、开盖0、合盖1。原版 JVM 已复现 `4/0` 错判 false、`1/1` 错判 true。

产品改动只有 **1 行说明 + 删除 2 个错误私有常量**，直接复用同包权威常量4/0。修改后 Coordinator SHA256 `df00a9ed2f858cb2723035784dfa2e514ed52aeb7e487339e4ad59cdb50979f9`。补丁文件 `mini009-usage-hall-fix.patch`，SHA256 `f9f3e6b12a8eb06ca3b4bee8b264a490b121b47d4cc45e705f366dc9d381da58`。

同一文件同时供快照和使用计时读取。无效/非活动 MCU 不累计；MCU 读回失败不能在每秒计时入口回退复用旧开盖状态。真实摄像头有人、配对/OTA/等待重启、可用时钟门均保留；普通设备使用仍不依赖 focusActive。60 秒分段、暂停/正常退出补尾、SQLite 水位事务、稳定 ID、ACK/重试均未改。没有历史补数、假事件、改 flag 或从在线/对话时长推算。

Rust、Godot、R1 Contracts/Store/Client/Coordinator、配置分发、所有资产、MCU、BLE、凭据及版本锁与 mini009 构建源保持不变。没有用 mini008 整文件覆盖 mini009 新模块。

## 3. R1 默认关闭及上线边界

mini009 已实现本地 R1 原子业务明细、原生持久交接与候选网络通道，但 `ArkRecordsCoordinator.kt:21` 初始 `enabled=false`；`:49` 仅消费配置。`DeviceRuntimeConfigPublisher.kt:62/74/88` 把原 config 的 payload 传入；`ArkRecordsContracts.kt:87–91` 仅接受以下精确对象：

```json
{"ark_records":{"enabled":true,"contract_id":"p003-ark-records-r1"}}
```

缺字段、错误合同、字符串布尔等保持关闭；开关关闭时本地记录与持久交接仍工作，网络上传不发。源合同要求服务端先回签路径、严格字段、ACK、拒绝/重试及身份上下文，再按单 C 开启。

**本轮服务端独立审查另发现 mini009 wire 与线上严格合同仍有不一致，配置继续关闭。** 本次开盖补丁没有解决该合同差异，也不包含开启网络的指令。不要把“端侧包已完成”说成“R1 可直接连当前服务端”，更不能用 config.enabled=true 绕过对齐。旧 Telemetry 使用时长通道与这项新 R1 开关分开，开盖修复本身不需要启用 R1。

## 4. 本轮验证

`TEST-RESULTS.json` 是本轮精确 mini009 加补丁的实际结果，详见对应日志；不继承原 mini009 回执计数。

- 全量原生 JVM **1883/1883通过，0 failure/error/skip**（161个suite）；`:payload:compileReleaseKotlin` 通过，Gradle本轮退出成功。**Release Kotlin编译不是完整签名APK构建。**
- 新 JVM 测试直接覆盖生产解码器的4/0、关闭/非法枚举，以及实际解码结果到Tracker的60秒段、5秒合盖尾段、无效 MCU 停止累计。
- Python 定向含既有遥测、锁序、生产接线及 mini009 R1，**40/40通过**；双入口摄像头/配对OTA/时钟门为源码接线守卫，不冒称真实传感器测试。
- 按仓库 `requirements-dev.txt` 在独立树本地 venv 安装 `jsonschema==4.25.1`，MCU 原构建输入验证 **PASS**，三个文件大小/SHA匹配。旧“缺 jsonschema”已解决，不能再作为最终阻断理由。
- macOS 默认临时目录 `/var`/`/tmp` 为路径别名，会被现有 MCU/资源包安全校验正确拒绝。新测试 JVM 指向项目内 canonical 临时目录；没有改安全校验或放宽断言。旧 mini008 完整门禁失败留证，不当成已知债或新修复通过。

本精确 mini009 修复树的完整 canonical quick 尚未运行，Rust/Godot/base重建与签名审包尚未执行；它们是后续候选门禁，不能用1883项原生通过代替。版本锁暂保持原mini009，仅为验证源补丁，不产出同名新包。

主机测试不等于最终 APK/设备验收；尚无本修复的签名 APK、C 活动包 SHA、真实入队/ACK/落库/小程序闭环。

## 5. Windows 应用及下一候选

接收方在 Android 仓精确对象存在后另建工作树，以 **006ac68a29447e8bc14fb655206d87bbf1f771a3** 为基线；先执行 `git apply --check` 再应用 `mini009-usage-hall-fix.patch`，核唯一产品改动和两项新增测试文件。随包 `patch-apply-check.json` 记录从精确基线独立应用后三文件的逐字节复核。

mini009 已占用，后继候选暂拟 **371_mini_010 / code371**，构建前再核占号；这是本轮候选安排，不是原出包回执声明。本源码补丁尚未改 VERSION.lock，**不可按原mini009名称直接重打交付**。进入候选构建前须再次核序号，统一版本/诊断标签/派生元数据并跑原完整门禁及最终签名审计。仅标候选，不安装、不 OTA。

当前已核有母包（与精确版本锁 SHA 一致）、JDK/Gradle/SDK/NDK/Godot与签名文件；不输出或打包凭据。完整构建前还需准备本树 Rust/Godot 导入、对应原始 smali fixture、既有 apktool/JDK路径，并完成本轮完整 quick、Rust/Godot/base/native release、签名/DEX/资源审计。完整门禁若未过，不能把定向通过当签名 APK 已可交付。

Windows 回执只给出本地交付/证据路径，**没有提供可用远程连接入口，也没有 C 安装或真实 ACK 证据**。没有现场入口不阻碍交付源补丁，但不能宣布 C 已有使用时长。

实机仍需：先确认 C 身份、从 pm path 拉实际活动 APK核 SHA/签名/版本并保留回滚包；真实开盖读4/0、摄像头有人、无阻塞后普通使用超过120秒，核至少两段60秒和退出尾段，再以同一event_id对设备业务ACK、服务端focus_segment、家长usage与页面。不得清绑定/队列、伪造数据、移除开盖门或修改focusActive来通过。

署名：codex（OpenAI）| 2026-11-16（北京时间）
