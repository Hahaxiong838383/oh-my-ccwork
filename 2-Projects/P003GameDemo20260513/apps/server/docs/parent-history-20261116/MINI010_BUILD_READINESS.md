# 后续候选构建准备状态

> **2026-11-17 更新：下文“R1合同未对齐／配置继续关闭”是发布前旧快照，已被后续上线结果覆盖。** 服务端已于 **2026-11-16 23:11:30** 上线兼容入口；本轮复核C机配置为 **`cfg-182`、`enabled=true`、`contract_id="p003-ark-records-r1"`**。端侧默认`false`仍保留，收到有效配置即可上传，无需改成`p003.ark.records.r1`的context/origin流程。详见[mini010服务端就绪回签](../records-r1/mini010-readiness-20261117/P003_MINI010_SERVER_READY_20261117.md)。本更新仅覆盖R1兼容与开关结论，不改变下文对应日期的构建、安装和实机验收记录。

日期：2026-11-16。当前交付为精确 mini009 源补丁；未构建、安装或发布 APK。原008补丁只作对照，不用它覆盖009新增能力。

已完成：精确基线006ac68、最小开盖修复、全原生1883项、Release Kotlin编译、40项Python定向、原MCU固件输入门、精确基线补丁应用后三文件逐字节检查。母包SHA与VERSION.lock吻合，现有JDK/Gradle/SDK/NDK/Godot及签名文件存在；凭据未打开、未输出。

仍待执行的具体准备和门禁：

1. 后继候选暂拟371_mini_010/code371，构建前只读核最新占号，再统一版本锁、诊断标签及派生元数据。当前修复树尚未改号，不可直接重打原009名称。
2. 在本树准备对应原母包的smali测试fixture及现有apktool jar/JDK路径，使用可核Godot 4.6.1工具并生成**本树**导入缓存和同源host Runtime。不能拿旧主线APK/base代替。
3. Python进程TMPDIR/TMP/TEMP及测试JVM临时目录用canonical路径。此前008树的完整检查已证实macOS默认/var和/tmp别名会触发MCU/资源包路径拒绝，并使reparse模拟测试的路径mock失配；本009树的JVM临时目录已修正且1883项通过。不要改路径安全策略来适配主机。
4. 在本次最终候选源上跑原canonical quick（包含Python完整、产品配置/405图片闭包及精确已登记的5项架构债核对）、Rust/Godot测试与base重建、native payload、完整签名APK的证书/版本/DEX/资源/固件闭包审计。当前没有这组结果，不能声称已生成候选。
5. C实机回读活动APK/SHA/签名并保存回滚包，然后才安排安装及真实event_id→ACK→DB→页面验收。本轮没有Windows远程入口或C安装证据；这些不阻碍源码交付，但阻止实机完成声明。

此前缺jsonschema的依赖已在本树 `.tools/usage-build-venv` 按仓库锁定4.25.1解决，MCU门已通过。formal-build技能本机缺失也不是此处声明“不能构建”的依据；当前明确状态是上述完整候选准备/门禁尚未完成，没有绕过它们生成APK。

R1仍默认off；本轮服务端审查发现合同差异，需另行对齐后再单C启用。使用时长走原Telemetry通道，本开盖修复不依赖启用R1网络。

署名：codex（OpenAI）| 2026-11-16
