# C 机使用时长缺失调查

**结论：已从既有 GitHub 远端取得精确 mini008 构建提交，确认其开盖枚举写错，导致正常 MCU 工作态 4／Hall1 开盖态 0 被判为 lid_open=false。这是精确源码中的确定性缺陷，并与 C 机 541 条快照全部 false 一致。C 当前活动 APK 字节及原始 MCU 实况仍待回读；源码修复及测试已完成，安装和真实时长闭环尚未完成。**

日期：2026-11-16。对象仅 C 机 `BJP00326081002000031` / `dev_50b5415662259045`。

## 已核事实

生产数字由主执行者本轮只读 SQL 核对；本报告作者只读审查本地源码、既有协议和证据，不访问生产或设备。汇总原始证据见 [LEGACY-DATA-AUDIT.json](../records-r1/summary-20261116/LEGACY-DATA-AUDIT.json)。

| 证据 | 结果 | 能说明什么 |
|---|---:|---|
| 已保存快照 | 541 条 | 状态上传链确实工作过 |
| `lid_open=false` | 541 条；true 为 0 | 云端收到的开盖判定始终为 false；不能推出物理盖板始终关闭 |
| `focus_active=false` | 541 条 | 专注模式字段始终 false；按 mini008 使用时长合同，它不应成为必要计时门 |
| `present` | true 110、false 387、null 44 | 有过摄像头在位阳性上报，但不能据离散快照推算持续使用时长 |
| `focus_segment` | 全历史 0 条 | 没有可用于使用时长聚合的已接收片段；旧 daily.focus_ms=0 不是实测零使用 |
| 姿态事件 | 全历史 1243 条 | 与 focus 生成路径独立，不等价于已有使用分钟 |
| 2026-11-16 姿态 | 2 条：correct 1、deviated 1 | 是检测轮次；不是已播放提醒次数，也不是使用时长 |
| presence 变化 | 全历史 760 条 | 不能在服务器将两次变化间隔自动补成 focus 片段 |
| 现存主后台 C 遥测日志 | 691 行；非零 acked 286 行、非零 rejected 0 行 | 现存窗口没有服务端拒绝样本；不能覆盖已轮转或缺失日志 |

mini008 合同要求“开盖＋摄像头真实有人＋MCU 状态可用”，普通浏览、游戏、设置、聊天均可计入，约 60 秒形成非重叠片段并在离座/合盖时补尾。见 [真人三方协作联调手册](../../../../docs/mini008-realdata-20261111/P003_mini008_真人三方协作联调手册_20261112.md)。云端未收到任何 `lid_open=true` 与此计时门缺口一致，但快照不是连续门状态日志，尚不能唯一定位故障。

## 精确 mini008 取源确认（本轮新增）

本轮只读 `git ls-remote` 核已知 origin `https://github.com/FUTURUS-ProductResearch/kidshub-ai---godot.git` 的既有小程序分支，随后执行 `git fetch --no-tags origin f083b6e4066c8bbfda43f53e2bd8b8723a9810c0` 成功取到精确对象；未 checkout，原工作树 HEAD 和未提交文件未变。分支当前头不是构建锚，以下只看精确 f083 提交。

- 精确提交：`f083b6e4066c8bbfda43f53e2bd8b8723a9810c0`，2026-11-10 18:01:09 +0800，`build(miniapp): freeze mini008 real-data formal candidate`。
- 精确 `P003TelemetryCoordinator.kt:575,625–626`：`lidOpen = workState == WORK_ACTIVE && hall1State == HALL_OPEN`，私有常量仍为 **1 / 1**。
- 同提交 `WelcomePolicy.kt:122–124`：MCU 权威常量为 **WORK_ACTIVE=4、HALL_OPEN=0、HALL_CLOSED=1**。
- 同提交 Coordinator `:95–105`：每秒读取实际 MCU 状态，并用上述错误 `lidOpen` 联合摄像头、配对/OTA/时钟门判断；`:511–512` 的状态变化路径也用同一错误判定。
- 此精确提交**已经取消 focusActive 对使用计时的限制**。不能把541次focus_active=false当成当前时长根因；旧 `shouldCountFocusSegment` 函数虽仍在 Contracts 中，但新使用采样路径不调用它。
- `TelemetryUsageTracker.kt` 确有60秒截段、5秒观察断档/2秒墙钟偏移保护；`P003TelemetryStore.kt:113–137` 原子持久化事件与结束水位，事件type=focus_segment、occurred_at_ms=end、data只有整数start_ms/end_ms。这些新功能存在，但正常4/0输入在上游开盖门已被拒绝。

静态行为对照（从精确源码表达式直接确定，不冒充实机执行）：

| MCU work / Hall1 | 原始语义 | mini008 Telemetry 判定 | 影响 |
|---|---|---|---|
| 4 / 0 | 正常工作、开盖 | false | 普通正常使用无法通过开盖门 |
| 2 / 1 | 合盖 | false | 此分支结果正确，不能因此证明映射整体正确 |
| 1 / 1 | 非正常工作、合盖 | true | 还存在误把非工作合盖态视为开盖的方向性缺陷 |

精确文件 SHA-256（路径前缀均为 `android_injection/livekit_sdk_probe/payload/src/main/java/com/futurus/p003/launcher/voice/livekit/`）：

| 文件 | SHA-256 |
|---|---|
| `P003TelemetryCoordinator.kt` | `8fdafc52c8b2fa67d7b89588531238bf8f64523b139752b7c13ac89ee6215df6` |
| `WelcomePolicy.kt` | `8309413a67d95a7ad6f06ce9e57a265e5d5a7d1202713ae6f2bbbbcf05da527c` |
| `TelemetryUsageTracker.kt` | `8722a681cdd94c55826b83b9bc2443a4818e11d99b887eeef3abcffadc8e8cb3` |
| `P003TelemetryStore.kt` | `79de28d6a111a414dba20c50cd2d3899ed38d8ed9ed7133dd6db02d589122f51` |

这已将“旧源可疑”推进为“mini008精确构建源错误已证”。最后一段证据仍需当前活动APK SHA/DEX与C的MCU原始状态对应，不能跳过真实设备验收或直接将云端旧false改写true。

## 最初旧基线比对与硬件协议旁证

本地 Android 仓库：`/Users/fu-121/mycc/2-Projects/kidshub-ai---godot`，当前 HEAD `ab3241d08419e004206cbdf27a44cf8194b04fb9`（2026-09-02）。下列源码是这一旧基线，**不是 mini008 精确构建源**。

| 路径（相对 Android 仓根） | 已读代码/含义 |
|---|---|
| `scripts/patch_launcher_livekit_probe.py:1213` | `p003ReadDeviceCommandState()` 从 `DeskMcuSharedRuntime` 的 `DeskMcuStateRepository.currentState()` 直接取原始字段；无 currentState 时返回 null |
| 同文件 `:1237` / `:1305` | `values[0]` 是原始 `getWorkState()`；`values[8]` 是原始 `getHall1State()`，不是布尔归一化值 |
| `android_injection/livekit_sdk_probe/payload/src/main/java/com/futurus/p003/launcher/voice/livekit/P003TelemetryCoordinator.kt:425` | 反射读上述数组，少于 10 项或调用失败返回 null；映射 workState=values[0]、hall1State=values[8] |
| 同文件 `:441`、`:493–494` | Telemetry 判定 `workState == 1 && hall1State == 1` 才开盖；其私有常量为 WORK_ACTIVE=1、HALL_OPEN=1 |
| `android_injection/livekit_sdk_probe/payload/src/main/java/com/futurus/p003/launcher/voice/livekit/WelcomePolicy.kt:110–112` | 同一 MCU 链的欢迎策略常量为 WORK_ACTIVE=4、HALL_OPEN=0、HALL_CLOSED=1 |

两处消费者对同一 MCU 原始枚举的解释冲突，是本地旧源码的确定性缺陷。仓内历史实测也支持欢迎策略的值：

- `reports/P003_WELCOME_CANARY_20260821.md`：真实开盖观察 Hall1 `1→0`，随后确认 workState=4。
- `reports/P003_ANDROID122_MCU_SLEEP_LED_AUDIT_20260824.md`：开盖工作态 `workState=4/hall1=0`；合盖 `workState=2/hall1=1`；workState 1/2/3 会关闭背光，4 恢复。
- `reports/P003_SALES_DEMO_01_HALL1_SIGNAL_FLAPPING_20260902.md`：MCU `0x0100` payload Byte8 为 Hall1，0 开、1 合；现场错误合盖脉冲为 `workState=2/hall1=1`，恢复 `workState=4/hall1=0`。
- `reports/MCU_FULL_DEVICE_CONTROL_VALIDATION_20260818.md`：payload[8]→Hall1、payload[9]→Hall2。Hall2 是另一遮光结构状态，不能替代 Hall1。

上述初始怀疑已被本轮精确 f083 源码证实，见上一节。当前 C 活动 APK/DEX 和原始 MCU 状态尚未独立回读，别台历史 MCU 实测仍不能替代 C 当前硬件事实。

另一个边界：旧 `readDeviceState()` 只检数组存在及长度，没有在 Telemetry 层验证 work/Hall 枚举和新鲜度；非空但未知或失效值也可能被比较成 false。因此 false 不自动等于“已确认物理合盖”，还须核原始值、有效性和最后更新时间。实现修复若涉及此项，应在精确分支评估 unknown/null 语义。

## mini008 源码与安装证据边界

历史客户端回执声明：

- 版本 `371_mini_008`，versionCode=371；mini 系列共用该 code，不能只核 code。
- 源码提交 `f083b6e4066c8bbfda43f53e2bd8b8723a9810c0`。
- APK `85329509` bytes，SHA-256 `57ca06637aff8097997e6eb9ef11cd7ef9255c97a940883ddfbbaf975533bf23`。
- Windows 证据目录 `C:\Users\Administrator\Documents\Codex\P003\mini008-prepare-20261111`，含 `INSTALL_RECEIPT.md`、`device-diagnostics.log`。

见 [DEVICE-AUDIT.json](../records-r1/summary-20261116/DEVICE-AUDIT.json)。最初本机确实没有精确提交或 mini008 工作树，随后已从既有 origin fetch 精确提交并完成上节源码取证；该 APK 本体与 C 当前活动字节仍未取得。

主执行者追加只读核验：`ota_device_status` 最近一次自报为 `371_mini_008` / code371，last_check_at=`1794824970384`（北京时间2026-11-16 18:29:30.384），当前 epoch=2。该自报支持设备版本名仍是mini008，但不是本轮活动APK的SHA回读，不能代替完整构建身份。

本地旧源还要求 `focusActive && lidOpen && present && !blocked`，且只在结束时入队，没有约60秒截段。精确mini008源码已验证这两点确实改为普通使用与周期截段，故它们不是当前已发现的根因。

## 网络、服务端拒绝和设备门的区分

| 观察 | 可以排除/支持 | 仍不能推出 |
|---|---|---|
| 状态、姿态、presence 持续有已保存记录 | 不是这些窗口内设备所有 Telemetry 都完全断网或被统一拒绝 | focus 类型一定产生过、其批次一定发出或被接收 |
| focus 原始表完全为空；现存C遥测日志非零rejected为0 | 服务端没有已持久接收的有效该类事件，当前已见日志也不支持“被服务端拒收” | 端侧从未入队；也可能存在未发送、重试、死信，或已轮转窗口内的拒绝 |
| 所有已接收快照 lid_open=false | 优先检查原始 MCU→开盖语义→计时门；不能先用聚合代码“补分钟” | 物理盖板没开、Hall 传感器坏、mini008 确实装错常量 |
| 旧 Ark state 403 | 只描述当时 Ark 独立授权链 | Telemetry focus 同样403；两条路径不能混为同一故障 |

现役服务端只根据有效 `focus_segment.data.start_ms/end_ms` 聚合，未要求快照 `focus_active=true`。非法区间可能逐条拒绝 `invalid_event_data`，重叠片段可能 `focus_segment_overlap`。是否真的出现必须看该 event_id 的上传体和响应；不能只看到 HTTP200 或 pending=0 就判成功。当前没有端侧 focus ID/ACK 证据，拒绝分支没有被坐实。

## Windows 最短只读诊断

以下在连接 C 机的 Windows PowerShell 执行，均只读取设备或复制 APK 到电脑。先核 SN；不要自动选择列表第一台。日志只保留指定状态行，不收集儿童对话或凭据。

```powershell
adb devices -l
$P003Serial = '<从列表核对的 C 机 ADB serial>'
$P003Package = 'com.futurus.p003.launcher'
$P003Sn = (adb -s $P003Serial shell settings get global p003_mcu_device_sn).Trim()
if ($P003Sn -ne 'BJP00326081002000031') { throw '不是 C 机，停止诊断' }
adb -s $P003Serial shell settings get global p003_device_telemetry_enabled
adb -s $P003Serial shell settings get global p003_device_telemetry_min_upload_sec

$P003ApkPaths = @(adb -s $P003Serial shell pm path $P003Package |
  ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^package:' } |
  ForEach-Object { $_.Substring(8) })
if ($P003ApkPaths.Count -ne 1) { throw '活动 APK 路径不唯一，先人工核对，禁止猜版本' }
adb -s $P003Serial shell sha256sum $P003ApkPaths[0]
$P003EvidenceDir = Join-Path $PWD ('p003-usage-readonly-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $P003EvidenceDir | Out-Null
$P003LocalApk = Join-Path $P003EvidenceDir 'active-launcher.apk'
adb -s $P003Serial pull $P003ApkPaths[0] $P003LocalApk
Get-FileHash -Algorithm SHA256 $P003LocalApk
(Get-Item $P003LocalApk).Length
# 若本机已有 Android SDK aapt，则读取刚拉取的实际活动 APK：
aapt dump badging $P003LocalApk | Select-String '^package:'
```

`aapt` 不在 PATH 时使用本机已有 SDK build-tools 中的 aapt.exe；本轮不安装依赖。以 `pm path→APK SHA→拉取字节→aapt` 为完整版本证据，不从可能混有系统旧包条目的 `dumpsys package` 单独认定活动版本。

读取现有环形日志中相关状态行：

```powershell
$P003StatePattern = 'P003Telemetry.*state=telemetry_|P003Welcome.*state=welcome_mcu_baseline|P003PosturePresence.*state=posture_presence_camera|(?:DeskMcu|McuUartService).*(?:workState=|hall1=|hall2=|0x0100)'
adb -s $P003Serial logcat -d -v threadtime |
  Select-String -Pattern $P003StatePattern |
  Set-Content -Encoding UTF8 (Join-Path $P003EvidenceDir 'state-only-existing.log')
```

需要现场短窗时，将 `-d` 去掉，用相同过滤写入 `state-only-live.log`，观察后按 Ctrl+C 结束。**不要 logcat -c 清旧日志；不要采集或转发完整原始 logcat。** 标签/字段可能随精确包变化，过滤结果为空只表示未匹配，不能当作 MCU 没上报。此时先在拉取 APK/精确源码中核日志标签，不能靠改开关、重启或强制造帧补证。

Windows 端回传的最小脱敏字段：

1. 完整 C SN、APK SHA/字节数/versionName、北京时间；物理盖板当时开/合由现场记录。
2. 同时刻 MCU 原始 `workState/hall1/hall2`、快照来源/有效性/最后更新时间；反射桥是否成功、数组长度及 `[0]/[8]/[9]`。**后面这些内部字段若现有日志未暴露，则从精确源码与既有诊断产物核查，本轮不安装探针。**
3. Telemetry 算出的 `lid_open`、camera present/unknown、配对/OTA阻塞、计时门结果和片段开始/结束时间。
4. 若生成片段：event_id、batch_id、start/end、入队/pending、HTTP及逐ID ACK/rejected、对应服务端持久记录。禁止回传 Bearer、手机号或儿童语句。

## 如何据证据选择最小修复

| 同窗证据 | 下一步 |
|---|---|
| 物理开盖，原始 MCU=4/0，但 Telemetry=false；精确 APK 确认仍为1/1 | 在 mini 分支修正/复用 MCU 权威枚举，补 `4/0→开`、`2/1→关`、未知/失效不累计的行为测试；保留真实开盖门，再按独立包流程构建验收 |
| 物理开盖，原始 MCU仍报合盖或工作态非4 | 先核 Hall/MCU/机构与原始状态有效性；不要在 Android 或服务器强改为开盖 |
| 原始状态缺失/过期，但被下游表示为false | 修状态有效性及未知语义，保留 fail-closed 计时；不将未知当开盖 |
| lid_open=true、camera present=true、MCU有效且无阻塞，但没有片段 | 核实际运行包、可用时钟、每秒观察、60秒切段/退出补尾的实际调用；已核精确 f083 普通使用门不依赖 focusActive，不能把改该 flag 当修复 |
| 已有本地片段，服务端未收到 | 沿不可变 event_id 核队列、发送及逐条响应，修对应传输/数据校验，不改使用时长门 |

本轮不生成新版 APK，不修改 MCU、霍尔或计时 flag，不删队列，不把对话/在线/姿态轮数换算为使用时长。

## 2026-11-16 源补丁交付补充

已从精确 f083 创建独立工作树 `/Users/fu-121/.codex/worktrees/p003-mini008-usage-fix-20261116`，修复只删除 Telemetry 内错误的两个私有常量并复用同包 WelcomePolicy 的 4/0（产品 +1 注释/-2 常量）。原 Android 工作树和分支未改，没有拿主线替代。原版 JVM 真实解码 3 项中 2 项失败，修后遥测/欢迎相关 **88/88**；含新生产解码器到 Tracker 的60秒分段、5秒合盖尾段、非法 MCU 停止累计。Python 接线与既有遥测 **26/26**，保护摄像头/配对OTA/时钟门，不等同实机测试。

补丁 SHA256：`f9f3e6b12a8eb06ca3b4bee8b264a490b121b47d4cc45e705f366dc9d381da58`；修改后 Coordinator SHA256：`df00a9ed2f858cb2723035784dfa2e514ed52aeb7e487339e4ad59cdb50979f9`。完整源补丁、红绿日志与 Windows 交接在上述独立树 `reports/mini008-usage-fix-20261116/HANDOFF.md`，并打包为 Downloads 的 `P003_C_USAGE_FIX_20261116.zip`。

**本轮只交付源补丁，未构建/安装新 APK，未发布 OTA。** 原母包与 f083 版本锁 SHA 核对一致；JDK/Gradle/SDK/NDK/Godot及签名文件存在，但当前 Python 缺 `jsonschema`，原 MCU 构建输入验证器实际报错，完整 quick/freeze、Rust/Godot/base/native release、最终签名包审计尚未执行；精确 mini008 APK及 C 活动 APK也尚未取得，不能做字节对照和现场回滚闭环。不能因本地主机测试通过就把旧主线包当修复包，或将原mini008同版本重打当原验收产物。源码修复与 C 现场闭环分别报告。

署名：codex（OpenAI）| 2026-11-16
