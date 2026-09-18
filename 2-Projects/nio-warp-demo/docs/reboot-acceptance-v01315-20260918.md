# 2026-09-18：v0.13.15（67）整机重启后检查

## 结论

用户已重启开发机并完成本机测试。核对本次开机后的记录，组网、ProtoPie 全屏来源、Warp 捕获与输出、鼠标输入链路正常；本次开机后没有异常退回或相关崩溃报告。用户明确说明测试后主动退出 App，因此检查时 App 和专用 Chrome 已关闭属于预期状态，本轮没有重新打开或注入输入。

另发现系统禁休眠标志已为关闭。已恢复开启并增加标准开机恢复任务，首次执行和当前值核验通过；**新任务尚未经过下一次整机重启，也未新增物理合盖测试**。

## 实测证据（时间统一为北京时间）

| 项目 | 本次结果 |
|---|---|
| 系统启动 | `kern.boottime` 对应 2026-09-18 22:02:32；采用的播放器/输入记录均晚于本次启动 |
| EasyTier / SSH | 实际 SSH 服务端为 `10.10.10.14:22`；`cn.easytier.mesh` 开机运行，PID 514、runs=1、无退出；Wi-Fi 此时 `192.168.1.58`，仅记录当前 DHCP 快照 |
| 应用 | 固定入口 v0.13.15（67），源码摘要和 Bundle 一致、严格签名通过；无本次启动后的 NIOWarp/Chrome/WindowServer 崩溃报告 |
| 实体显示器 | AU16O 3840×2400、逻辑1920×1200、2×、60Hz；内外屏均 active、未睡眠 |
| ProtoPie 全屏 | 本次启动后 `monitorComplete`：`fullscreen`，窗口/捕获/源屏均1920×600，`geometryReady/layoutReady=true` |
| Warp | 输出帧、元数据、来源可用；来源、配置及渲染版本匹配；输出在当前 Space 可见，坐标与AU16O匹配 |
| 输入 | 本次仅2条主动 Esc 停止，停止前 transport connected、队列为空；viewport ready、URL/target匹配、未拒绝；原光标从当前页面缓存取得 |
| 参数 | 与67验证基线比较9项保存键，鼠标/ProtoPie/其他显示器配置保持；家中整体Y仅从 `-93.68523296460597` 保存为 `-93.68523296`，相差约 `4.6×10⁻⁹ px`，并产生历史记录；未回写旧值 |
| 光标设置 | glass、左右反向开启、真实点击开启、自动隐藏2秒保持；本轮未单独重新注入按键或验证全部交互组合 |
| 常亮 | 电池/接电 `sleep=0 displaysleep=0 disksleep=0`；屏保普通域/currentHost的idleTime均0；当前接电100% |

原生源码摘要：`0723d7853c18d5400202f1dee43faf101299f649c3a7cce2aa1e334f0c60347b`。应用代码仍为 `cbe5d7fd`，本轮未重建或替换 App。

## 禁休眠修正

初检 `pmset -g` 的 `SleepDisabled=0`、IORegistry的 `SleepDisabled=No`，电源偏好文件的对应值也为false。旧记忆中的已开启状态不能作为本次真值。当前记录不足以确定是哪一步把它改回0，因此不宣称该设置必然在每次重启时丢失。

安装 [com.mycc.nio-warp.awake.plist](../scripts/com.mycc.nio-warp.awake.plist) 至：

`/Library/LaunchDaemons/com.mycc.nio-warp.awake.plist`

- root:wheel、0644；开机执行 `/usr/bin/pmset -a disablesleep 1`。
- 命令成功后退出；失败时由 launchd 重试，最短间隔30秒。未增加循环驻留进程。
- 首次 bootstrap 的 `runs=1`、`last exit code=0`；回读 `SleepDisabled=1`、IORegistry=Yes。
- 正常可见的系统任务，管理员可停用/删除；不做隐藏或防卸载。
- 之前 `sleep/displaysleep`、网络与App参数未修改。

备份：`/Users/futurus/mycc/2-Projects/nio-warp-demo/.rollback/power/20260918-141140Z-awake-boot`，含修改前电源设置、完整电源偏好及执行回执。

恢复本次修改前的禁休眠状态（会重新允许系统睡眠，不用于日常运行）：

```sh
sudo launchctl bootout system/com.mycc.nio-warp.awake
sudo rm /Library/LaunchDaemons/com.mycc.nio-warp.awake.plist
sudo pmset -a disablesleep 0
```

## 验收边界

本轮以用户完成的冷启动操作及本次启动后的日志为证据，未把跨重启持久化的旧runtime当作当前运行状态。App已主动退出，保留退出状态；不把历史有效帧标志当作实时帧率或当前输入测试。UU后台已启动，但没有做端到端远控；所有按键组合、其他屏幕、真实玻璃光学及新任务下的下一次重启/合盖仍未扩大验收。

署名：codex（OpenAI）| 2026-09-18
