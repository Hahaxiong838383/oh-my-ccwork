# v0.14.7 固化与全部预设备份

2026-09-21。用户确认重启测试基本正常，并授权更新记忆、commit + push、导出「预设与历史」中全部预设。

## 固化版本

- 开发机：`nio-war-mac`，固定安装路径 `~/Applications/NIOWarpApp.app`，v0.14.7（75）。
- 功能源码提交：`35374e591a732e885b5dd6a849cbf7c096c42246`；重启验收文档：`365a758b36477abcfb7a39abe4d28aee9607f252`。
- 源码 SHA-256：`807c7b37aa3f22d7d761a6e23bcaee7853a928d007075d1b45a8e91c20c2e81f`。
- 最近积累的 5 个本地提交已整体推送原仓库 `Hahaxiong838383/oh-my-ccwork` 的 `codex/nio-protopie-autoplay-20260920`，远端 SHA 核对至 `365a758b`；两个实施前回滚标签也已推送。本记录将随同分支继续提交、推送。
- 版本固化标签：`nio-warp-v0.14.7-frozen-20260921`。持久控制/兼容降级、首项重播、状态澄清与重启验收范围详见对应发布文档；没有扩展为所有输入或正式屏光学验收。
- `0-System` 是共享记忆目录的已跟踪符号链接，实际记忆位于 Git 目录外；关键结论同时保存在本项目文档，以便仓库恢复。独立 WarpDemo 分发仓不是自动双向同步，本次推送现用原仓库分支。

## 全部预设快照

- 导出时间：`2026-09-21T08:16:15.204582+08:00`。
- **9 个命名预设**：全部原始集合，加 9 个独立可导入参数 JSON；保留名称/ID/创建时间和完整 configuration，包括原先存在的外扩基线。
- 附加 **4 个显示器当前参数档、30 条历史记录**及最后使用的显示器档名。原始 Data 和 UserDefaults 类型完整保留。
- 包名：`NIO-Warp-Presets-20260921-081614.zip`，73049 字节。
- ZIP SHA-256：`fcdd43a9d005ff892f29a6f49806842da282b993e2a662ab1f3b35934a40c530`。
- 原始预设集合 SHA-256：`d475c991631fc3eca6fd64ce9fe4be2dbfffb3f5e05a719d95efef489e77ad1f`。
- 本地副本：`artifacts/NIO-Warp-Presets-20260921-081614.zip`。
- 开发机副本：`/Users/futurus/Documents/NIO-Warp-Backups/NIO-Warp-Presets-20260921-081614.zip`。
- 包内提供 `恢复说明.md`、`manifest.json`、`SHA256SUMS.txt`、完整集合、参数专用 plist、独立配置和历史。参数原件作为附件与两机本地备份保留，Git 只保存本记录和校验摘要。

## 检查与恢复口径

- 9 个独立 JSON 与各源 configuration 深层一致，集合 Data 字节完全一致；ZIP CRC、重新读取及远端副本 SHA 均通过，导出后源预设哈希未变。
- UI 单配置导入应选 `presets/` 下的文件，并连接对应显示器。导入后再次保存预设会生成新的 ID/日期；全库无损恢复需退出 App 后只还原对应偏好键。
- 不可将参数专用局部 plist 覆盖导入整个应用偏好域，避免影响 ProtoPie、鼠标等其他配置。
- 本次未切换/应用预设、重置参数或中断正在运行的演示；也未执行恢复写入。

署名：codex（OpenAI）| 2026-09-21
