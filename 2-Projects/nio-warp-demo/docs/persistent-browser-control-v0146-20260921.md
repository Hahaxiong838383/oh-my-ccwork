# 浏览器持久控制修复与回滚记录

2026-09-21。**v0.14.6（74）已安装至 nio-war-mac，专项、实机交互及用户指定的 10 分钟连续轮播验收通过。本轮不安排 8 小时长稳。** 用户授权先保留现役控制机制和回滚点，再集中修复连接持久复用、页面切换及断线回收。自动重启 App / 自动续播保护仍暂缓。

## 回滚基线

- 原人验应用：v0.14.5（73）；应用源码对应 `28e49019cc90723f30520625e3b0ece3f47e94c1`。
- 本地注释标签：`nio-warp-before-persistent-cdp-20260921`，指向实施前 HEAD `64bf92a07892bcd3aa072a6d9bf1d25a9f785526`（包括昨日方案归档）。
- 开发机完整配对备份：`/Users/futurus/mycc/2-Projects/nio-warp-demo/.rollback/pre-change-baselines/20260920-232821Z-before-persistent-cdp-v0145`。
- 完整旧 App ZIP 已通过解包测试，SHA-256：`a23fadc68f0c0a5bdfdfbbefef8599d8c881b149e9471d436651a3e5f83d47a5`。
- 完整 native 源码 TAR：`1c5d754627fdf6a12690a2e25e55958711b51192252fa87ae2695536a1db9a22`。
- 07:28 参数快照：`66b51b49f73a0814f1df933acbcdb9e4bfefbb62460232f27c69f9631df07b99`；后续安装另取正常退出后的最新快照。此处旧参数仅用于追溯，不自动覆盖用户后续手调。
- 旧应用源码指纹：`147763497c84c31fbbc5420a03b843e26984b7084fbbb433d3025f15128a56e6`；旧可执行文件指纹：`591d7c4e7ddb0d8c1695534329def17d76d02f4d70308f1b4412a6b7edef9519`。

## 实现范围

- `ProtoPieCDPTransport` 持有专用浏览器的一条 WebSocket。页面命令使用 `Target.attachToTarget(flatten: true)` 的逻辑会话；换页不再新建网络连接。
- 请求 ID、连接代次、页面 session 三层匹配；超时/取消均有界，未知执行结果不自动重放。断线拒绝在途命令并清空会话，后续新请求可有限重连。
- 页面关闭仍服从原 `ProtoPieCloudTargetLifecycle` 的所有权判断。确认关闭/不存在后清理本地会话，避免重复 detach 误判连接故障；普通停止保留播放器。
- 新旧 browser endpoint 切换有代次隔离，旧页面的迟到清理不能抢占新连接。
- 默认最多 64 个在途请求、8 个页面会话、每次 App 生命周期 16 次连接创建；异常反复断开达到上限时停止重连并提示处理。没有 App 自动重启。
- 原 `ProtoPieCDP.call` 函数原样保存在 `ProtoPieLegacyCDP.swift`，通过 `ProtoPieBrowserControl` 分流。原鼠标/键盘输入连接保持独立。
- `ProtoPie 联动 → 云端播放与自动演示 → 运行日志` 增加「使用兼容控制（原机制）」。默认持久连接；模式在 App 启动时确定，重开生效，不在请求中途切换。
- 诊断键 `nioWarpProtoPie.controlRuntime.v1` 仅保存模式及连接/请求/会话等计数，不保存链接、target、命令或内容。

## 降级和完整回滚

优先降级：在上述运行日志勾选「使用兼容控制（原机制）」，正常退出并重新打开 App，确认显示「本次运行：兼容控制（原机制）」。取消勾选并重开可回到持久模式。兼容模式保留旧行为，也保留旧的长期内存增长风险，适合临时回退。

GUI 不可操作时，可在开发机正常退出 App 后执行：

```sh
defaults write com.mycc.nio-warp-demo nioWarpProtoPie.controlMode.v1 -string legacy
open -a /Users/futurus/Applications/NIOWarpApp.app
```

完整回滚：先正常退出 App、导出当时最新参数；核对备份 manifest 和 ZIP 哈希，恢复备份 App 至同一安装路径并恢复匹配 native 源码（删除本次新增源码），验证源码指纹及代码签名后启动。保留当时最新参数，只有用户明确选择旧参数时才导入备份 preferences。不要用 `git reset --hard` 回退整个共享仓库。

## 验收记录

- 发布构建、固定 App 路径与签名 designated requirement 校验通过。新增 8 个文件/文件修改同步后，源码指纹与 App 内置指纹均为 `b054d0e276452e2119f1b43297cca428790c89c007f3950379d389c8c14aa448`；可执行文件 `9e3b5a50daa7b43074a653b2b858da31f57575ee7d4b41b2d48f82bd2212fddd`。
- 原 86 项 / 476 断言、transport 17 项 / 70 断言、wrapper 8 项 / 154 断言通过，共 111 项 / 700 断言。执行原生产源与原测试方法的独立 assertion shim，**不是正式 XCTest**。
- transport 专项覆盖并发乱序、同页 attach 去重、错 session、取消、超时不重放、断线有限重连、旧 endpoint、目标关闭/detach 乱序、200 次页面生命周期。wrapper 另用真实本机网络验证原机制 browser/page/取消，原函数与实施前 Git 版本逐字节一致。
- 生产真实 URLSessionWire + loopback 模拟 CDP 服务：12,000 次页面命令、200 次页面切换，总 12,903 条成功请求共用 1 条 WebSocket，最后 pending/attached/attaching 均 0。第二批 6,000 次冷却后 footprint 只增 0.172 MiB、malloc 降 0.024 MiB；原机制独立每 6,000 次约增 106.67 MiB。断线操作只发送一次，新 endpoint 可恢复，旧 endpoint 不能抢占。此项不是实际 Chrome 测试，本机没有安装 Chrome。
- 开发机**实际 Chrome**：持久控制 → GUI 勾选兼容控制 → 正常退出重开 → 原机制预览 → 取消勾选 → 重开恢复持久模式，全链路通过；原机制分支 53 条控制请求、持久 socket 0，恢复后单 socket 工作。
- 实机同配置再次预览复用页面；暂停/恢复强制创建候选页，取消后回收候选并保留单页，恢复轮播成功。源窗口/虚拟内容屏/捕获均为 1920×1100 全屏，layout/geometry/fullWindowVerified 为真。
- 实机原圆圈鼠标移动、点击、数字小键盘 2→0→1→2→3→4 均被实际 Chrome 接收为可信事件；Esc 退出返回内屏且指针可见。输入链路仍是原实现，没有新增替代光标。
- 安装前正常退出后再配对备份：`.rollback/app-installs/20260920-233719Z-before-v0146`；latest preferences SHA `0b71d6b2a07dd5744af2fb7e1a6d4b8e8329e0663ff2b8759f0bf9579b38c24a`。替换 App 前后 preferences 字节完全一致；完成两次模式切换与交互测试后，10 组校正/预设/鼠标/ProtoPie/播放列表设置仍一致，实体屏位置保持。
- 保留现场两链接 30/35 秒、自动按键脚本关闭的计划继续轮播。新只读采样目录 `~/Library/Logs/NIOWarp/Soak/20260921-074125-v0146-persistent`，App PID 30986，run `AAC2B12F-027D-46C8-98EA-12F3FAC99E17`；07:41 起原计划 8 小时，用户在 07:44 改为累计 10 分钟（至 07:51:26）；用户级任务 `com.mycc.nio-warp.soak-20260921-v0146` 无 KeepAlive、无重启修复。退出 App 或更换外屏会结束本段；换正式屏另起基线。
- 原 v73 采样已记录 `app_absent_after_recorded_end`，原用户停止与本次升级分开留档。新采样继续使用原脚本 SHA `8466859a8ccc75d4e11d7e2dbe34625c5199130451c542b83623462558388a23`；已有 RSS 告警过粗，仍须按完整 App 内存趋势人工判断，不能凭无告警判定长稳。
- 07:43 短时复核：同 PID 控制通道完成 539 条请求、仅 1 次连接、0 超时/断开、1 个稳定页面会话、无等待请求。计划两项均就绪、无 warning/error；FPS 约 60、来源/捕获/输出均匹配。07:40:43→07:43:28 App footprint 293.345→293.454 MiB，仅增约 0.109 MiB，尚不能外推 8 小时。
- 同进程两次只读 heap corpse（07:41:41→07:43:16）中 URLProtocol 与 NWIOConnection 均保持 3 个、CFHTTPMessage 保持 25 个；总堆对象 399247→399321。第二份完整分类筛选为 2 个 WebSocketTask；运行诊断仅 1 个控制 socket，另一任务未做对象级归属追踪，不能将两者都算活跃控制连接。第一份按前 250000 字符截存，WebSocketTask 行不在截存区，不能把缺行记作 0。

证据保存在 `artifacts/persistent-cdp-20260921/` 与 `artifacts/memory-cause-20260921/{transport-tests,browser-control-tests}/`（不入 Git）。实机脚本最初误把「预览所选」当成强制重播、随后遇到 AX 分段切换已生效但返回失效元素状态，均修正测试前提/验证后置状态后继续，未因此改业务行为或盲目重发点击。

根因及旧版对照见 [内存原因定位](memory-cause-v0145-20260921.md)。短时验收不能代替同条件 8 小时连续播放、完整声学/业务效果或正式 44.8 寸屏光学验收；本轮未重新验证合盖、物理重启和所有键盘类型。

## 用户指定的10分钟验收结果

- 已完成 07:41:26–07:51:26 固定 600 秒，同 App PID 30986、同运行计划，期间未人工重启或干预播放、注入输入或修改参数。
- 16 次来源就绪，两个链接均反复切换；0 失败/非 info 异常。40 条 health 最大间隔 16 秒，捕获、来源、可见输出全通过；FPS 59.83–60.04。
- App footprint 293.345→293.360 MiB，净增 0.016 MiB（区间 293.235–293.501 MiB）。未再现原约 149 MiB/小时的控制连接累积；此结论只覆盖当前 10 分钟。
- 控制通道累计 1692 条请求、1 次 WebSocket 创建，0 断开/超时、结束快照 1 个页面会话与 0 个在途请求；最终仅 1 个专用预览页面。
- 安装前的 10 组保存参数仍一致。临时只读采样器已正常停止，LaunchAgent 移入本轮日志目录归档；App 保持播放，后续可继续功能开发，无后台 8 小时测试。
- 证据：`artifacts/persistent-cdp-20260921/ten-minute-result.json`，远端同 Soak 目录 `ten-minute-result.json`、`control-observations.jsonl`、`samples.jsonl` 和播放日志。新控制计数专项采样从中段开始，其创建数为 App 启动以来累计值；原 60 秒资源采样与 App 每 15 秒 health 覆盖整个窗口。

署名：codex（OpenAI）| 2026-09-21
