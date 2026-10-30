# 电视启动耗时与联网提示

用于 X96 / Android 电视代理开机慢、当贝桌面联网提示、重启截图验收。
先按 [DNS 与冷启动维护](tv-dns-coldboot.md)核设备、前台、实际 stage 和授权范围；
读取/归档任务不触发重启。只读 Grok 审查与隔离测试不能写成其做过真机验收。

## 找准耗时，再换实现

按同一 boot 的 uptime 分开记录：早期 DNS 保护、Android 完成门、代理/worker 启动、
真实 DNS 查询、系统/应用缓存完成后的 ready、独立审计。墙钟会被校时调整；
脚本到达 `android_boot_complete` 的时刻也不等于 Android 自身刚完成。
2026-10-30 的旧 53.57 秒检查点曾被误读，优化后约 24 秒就到达相同门。

先测真实生产串行段。该盒 shell 每个 /proc 目录反复启动 readlink/tr 耗时明显；
单进程 native 全扫描可提速，但仍完整匹配 exe、完整 argv、PID/startticks，保留锁前/锁后核验。
helper 缺失、摘要/格式不符或读取异常回旧 shell；不把“不确定”当“无进程”。
`exe (deleted)` 沿用旧语义，运行中替换二进制另作设计，不能宣称已覆盖。
不为达标删掉双来源校时、DNS 防护或回滚检查，也不把微基准省时相加当真实启动承诺。

真实 DNS 查询通过仍可能早于缓存门十余秒；成功只认
`/data/adb/video-proxy/boot-ready-boot-id` 与 `/proc/sys/kernel/random/boot_id` 一致。
保留完整 ready 条件。按 128KiB/s 限速的 1MiB 测试只能证明路径与载荷完整，不是测速。

## 部署闭集与回退

从 live manifest 确认 profile 的受管文件集合与权限，勿固定“九文件”。当前 v2 为 16，
v1 为 15、legacy 为 9；事务外入口/保护脚本取 `boot-assets-current.json`。
整组回滚后固定入口须识别 `rolled_back_preserved`，防止下一 boot 装回坏包；
`applied-boot-id` 参与本 boot 回退，不能作为提速冗余删除。
先更新真源、测试和提交，再归档到 mycc；核已提交 blob 的 SHA 与 Git 可执行位，排除运行配置。

## 桌面提示的独立边界

源码入口：`~/home-lan/4-Assets/Code/tv-network-status/README.md`；可校验
[发布快照](../../../../2-Projects/vps-proxy/smarttube-tv/tv-network-status/README.md)。
复用独立 APK + root watcher，不扩 Netflix 无障碍包，不改代理事务或时钟入口。

- APK 不要读取私密代理目录或自行联网探测；root 仅传非敏感阶段与当前 boot 标识。
  exported 服务用 `android.permission.DUMP` 限制调用，验普通应用身份确实被拒；
  不能只因调用者是 shell/root 就断言权限可靠。
- 仅在 user 0 当贝桌面显示；窗口不可聚焦、不可触摸、不拦遥控器。离开桌面/心跳失联隐藏。
  先看目标 ROM 的真实前台事件格式再订阅，辅以低频有界快照；避免每秒全量 dumpsys。
- 成功从实际挂窗绘制起按 monotonic clock 显示两秒；重复 ready 心跳不能重置计时。
  当前 boot 已消费或成功发生在播放前台时静默结束，回桌面不补弹；该组件不是持续网络监控。
- 新 service.d 入口用空 PATH 实跑到后台完成事件，既有代理/前台与资产摘要前后核对。
  沿用专用签名，缺失则拒绝替换已装包；签名只存受保护凭据库，文档只写指针。
- 真机私有虚拟显示须先断言非默认且私有，可验真实 WindowManager、flags 与两秒计时；
  不能退回物理屏，也不能代替开机桌面验收。结束清掉窗口、服务、订阅与 watcher。

回滚按 helper README 只移除本组件入口、按完整 argv 停 watcher、卸载本包；不碰原代理和当贝时钟。
构建沿用现有工具链；JDK21 调 D8 时 Java 源用 `--release 8 -parameters`，不要为参数错误盲目换 SDK。

## 截图、前台和验收范围

重启前先估计截图延迟；本盒 4K PNG 编码/传输约 6～8 秒，大于两秒提示窗口。
窗口时长取同 boot 绘制/移除日志，截图只证实际外观；可预先安排短录屏或低分辨率采集，
不得延长生产提示、伪造 ready 或把预览渲染冒充真实截图。漏拍就记漏拍。

分别列明自动显示、离开桌面隐藏、人工 HOME 返回、成功消失及清理结果。
DIYP 直播样本不能替代 SmartTube 实际影片。恢复 DIYP 从当贝 MiTV 图标正常进入；
直接启动 non-exported 内部 PlayerActivity 即使 root 绕过权限，也会跳过 ForceTV native 初始化而闪退。
不要由此改播放器数据或把它归因代理。

2026-10-30 证据：优化版两次软件重启 ready 46.60/45.07 秒；浮窗版软件重启 ready 46.91 秒，
实际成功可见 2081ms。中途自动进入 DIYP，验收人工 HOME 回桌面。等待态截图漏拍；
物理拔电、该版 SmartTube 实播、长期稳定性与播放中主出口故障迁移仍未验。
详细时序、源码 SHA、截图与教训见[本轮复盘](../../../../2-Projects/vps-proxy/2026-10-30-电视启动与联网浮窗复盘.md)。
