# NIO Warp App 开发设备

2026-09-07，川哥确定后续 NIO Warp App 在 **nio-war-mac** 上开发。

## 当前版本（2026-09-18）

- 19:24现场已迁到家中：EasyTier SSH重连正常，Wi-Fi当前为 `192.168.1.58`（动态地址用前现查）。外屏 **AU16O 3840×2400**，逻辑1920×1200@60Hz；独立配置 `vendor-23667-model-41014-serial-16843009`。公司AUO配置与v0.13.6人验备份语义一致。当前家中画布5000×936、ProtoPie来源1920×936，全屏几何/布局就绪；只读检查未改参数。此前连接中断待补的部署标记与文档已同步完成。

- 当前固定入口 **v0.13.8(60)**：长按退回诊断版，修复首因被二次stop覆盖并记录失败现场；用户本轮长按未再退回，原故障根因仍未确认。配置保持，见[调查与回滚](held-mouse-diagnostics-v0138.md)。

- 历史固定入口 **v0.13.7(59)**：修复家中AU16O原生全屏Space未显示校正输出。实际accessory策略、三次返回工作台后的全屏覆盖检查通过，画布高按用户选择保留600。公司配置保持；见[本轮记录](au16-fullscreen-v0137.md)。

- 历史固定入口 **v0.13.6(58)**：Esc 返回可见工作台、独立退出兜底、虚拟屏指针找回，修复 ProtoPie 工具栏 56px 内边距导致的全屏误判。实机三轮进入/退出、工具栏往返与参数保持通过，用户确认“退出和鼠标都正常”。见[退出与鼠标恢复](protopie-visible-exit-v0136.md)。

- 历史固定入口 **v0.13.4(56)**：独立内容屏下保留原系统圆圈、实体输出接收并映射鼠标/键盘；真实硬件位移归零修复。实机点击、拖动、滚轮、数字键盘201234与Esc释放通过，参数保持。原演示控制开启，用户现场确认鼠标和键盘都正常。见[交互修复](protopie-input-v0134.md)。

- 历史固定入口 **v0.12.9(51)**：ProtoPie 页顶部整幅上下位置与画布页共用物理偏移，旧内部取景默认折叠；真实未松手拖动、保存、跨页同步通过。测试后保留 −100 px，等待用户手调。见[修复记录](protopie-output-position-v0129.md)。

- 历史固定入口 **v0.12.8(50)**：Cloud 播放器实际窗口/网页/捕获为 7680×2800，高度跟随画布；「画布与输入」新增整幅画面上下平移，保持曲面形状。现场选择恢复等比横向铺满，取景靠底；原几何保持。原生鼠标映射在独立内容画布下显式关闭，波浪问题仍待验，Air 未改。见[本版记录](protopie-canvas-height-v0128.md)。以下为历史版本。

- 历史固定入口为 **v0.12.3(38)**：校正ProtoPie原有圆形系统光标，无新增十字；用户已开启辅助功能权限。原指针身份、移动/点击/拖动/Esc/受控边缘/内屏恢复检查通过；玻璃现场反馈待补，前版确认对象有误。见[原生指针记录](native-cursor-v0123.md)。

- 历史固定入口为 **v0.12.2(37)**：增加鼠标左右反向开关，当前关闭；用户用本机鼠标右移，玻璃圆圈右移正常，已获现场确认。33项1953断言及实机开关A/B、点击/拖动/Esc通过，原8项配置及鼠标旧设置保留。详见[方向修复与验收](mouse-direction-v0122.md)。下方旧版本保留为历史记录。

- 已安装 **v0.11.5(32)**：ProtoPie Cloud 默认在目标外屏无边框全屏，窗口/网页尺寸稳定后绑定捕获；新建预览、返回内屏登录后再启动均通过。最终 Chrome 窗口、网页内容和捕获均为7680×936，消除原32px标题栏；42项独立测试通过，原校正/预设/历史保留。见[本次安装与回滚](protopie-fullscreen-v0115.md)。以下为历次版本记录。

- 用户确认的现场参数已固化为App预设`0918-44.8-2-固化`与[可导入JSON](../calibrations/20260918-AUO-44.8-confirmed.json)。已关闭电池/接电自动显示器休眠及自动屏保，内外屏亮屏即时复核通过；已关闭标定网格并回到ProtoPie预览。见[参数固化与常亮回执](calibration-freeze-and-awake-20260918.md)。

- 已安装 **v0.11.4(31)**：左中右三列比例标定圆纵向连续重复，圆大小与间距、现场校正参数保留；沿用垂直0.12～5.50×和弧度上限3。10项GPU测试与实机UI/ProtoPie捕获联动通过；网格输出开启，已返回标定与画质。详见[纵向重复与配对回滚](vertical-circle-repeat-v0114.md)。
- AUO For SGM外屏已接入，分辨率7680×936；当前校正配置与9月17日无屏验收时不同，不用旧参数覆盖现场。
- EasyTier SSH `10.10.10.14` 正常。Wi-Fi现为DHCP `10.8.1.115/24`、网关 `10.8.1.254`，当前地址直连SSH与ProtoPie Cloud HTTP200通过。旧自动回退地址 `10.9.1.230` 超时，尚未改默认连接脚本；DHCP地址用前现查。已接电、电量100%。

## v0.11.1升级记录（2026-09-17）

- 已升级 **NIO Warp v0.11.1(28)**，固定安装路径 `/Users/futurus/Applications/NIOWarpApp.app`；桌面 `NIO Warp.command` 入口不变。
- 设备项目源码已从旧0.9.2副本同步为 Air 人验通过的 `658d551c` 版本，源码指纹 `98eac0d9…f0fbbc` 与安装包相同；87文件校验、设备隔离 release 构建通过。仍是非 Git 副本。
- 原校正参数/预设/历史保留，旧 ProtoPie 云链接及自动启动意图已迁移。真实六Tab、退出确认、退出重启、停止/重试、专用播放器实际原型页面通过；没有外屏，捕获首帧与实际 Warp 输出待补验。
- 本次发现 Wi-Fi DNS 为空，已备份并恢复原 `223.5.5.5/223.6.6.6`，系统选路和 ProtoPie 直连恢复；固定IP、网关、EasyTier不变，未安装代理。
- SSH 以 EasyTier 优先、Wi-Fi 降级为准。旧0.9.10 App、参数、旧源码均有配对回滚，详见[安装验收回执](nio-war-mac-v0111-deployment-20260917.md)。下方按日期保留历史记录。

## 设备与网络真值

| 项目 | 已验证配置 |
|---|---|
| 设备 | MacBook Pro，macOS；原主机名 FUTURUSdeMacBook-Pro.local |
| 代号 / ComputerName / LocalHostName / HostName | nio-war-mac |
| SSH 用户 | futurus（全小写） |
| 雷电地址 | 192.168.101.5/24，目标接口 bridge0 |
| Studio 雷电来源 | 192.168.101.4，接口 en2 |
| Wi-Fi 固定地址 | 10.9.1.230/24，目标接口 en0，Manual Configuration |
| Wi-Fi 网关 | 10.9.1.254 |
| DNS | 223.5.5.5、223.6.6.6 |
| 地址保留 | 川哥确认网管已保留 10.9.1.230–234；本机使用 .230 |

此前的 Wi-Fi 地址 10.9.1.153 已废弃，不再作为连接入口。

## 连接方法

| 发起设备 | 命令 | 实际路径 |
|---|---|---|
| Studio | `ssh nio-war-mac` | 雷电 → futurus@192.168.101.5 |
| Studio | `ssh nio-war-mac-wifi` | Wi-Fi → futurus@10.9.1.230 |
| Air | `ssh nio-war-mac` | Wi-Fi → futurus@10.9.1.230 |

Studio 与 Air 各自复用已有 ED25519 密钥，仅将公钥追加到目标用户的 authorized_keys；未迁移私钥。上述连接均已通过 BatchMode 免密查询 hostname 和 SSH_CONNECTION 验证。Air 本轮来源为 10.9.1.110、用户 Rayman.Chen；Air 地址仍为 DHCP，用前重新发现。

## 后续开发边界

- 本项目现归属 `Hahaxiong838383/oh-my-ccwork` 仓库，目录 `2-Projects/nio-warp-demo`。
- nio-war-mac 已完成设备命名、静态网络和 SSH 授权。
- 2026-09-08 已从 Air 增量同步至 `/Users/futurus/mycc/2-Projects/nio-warp-demo`，173 个文件 SHA-256 全部一致；本机构建、安装并启动 v0.9.2 (17)，入口 `/Users/futurus/Applications/NIOWarpApp.app`。
- Command Line Tools 26.6 / Swift 6.3.2 已可用；缺少 XCTest，目标本地测试未通过。Air 同源测试 117/117 通过；uv 未安装验收。详见 [部署回执](nio-war-mac-deployment-20260908.md)。
- README 下方原 Air 的 `/Users/rayman.chen/...` 路径属于历史记录；新开发机使用上述 futurus 路径。桌面 `NIO Warp.command` 可启动安装版。
- 已配置禁止睡眠并实测合盖雷电/Wi-Fi SSH 正常；ProtoPie 10.4.0、UU 远程 4.39.1 已安装启动。用户已登录 ProtoPie，但 2026-09-08 15:57 MCP 仍返回未启用；UU 实际远控尚未验收。
- 不将登录密码、私钥写入项目或共享记忆。

署名：codex（OpenAI）| 2026-09-07（Asia/Shanghai）

## 2026-09-16 客户交付机组网

- EasyTier 显示名称：**nio 开发机**；公司普通成员，虚拟地址 `10.10.10.14`。
- Studio 连接：`ssh nio-war-mac-mesh`（用户 `futurus`）；已实测 SSH 登录成功。
- EasyTier 2.6.4；`cn.easytier.mesh` LaunchDaemon 正在运行并设开机自启。管理口仅监听 `127.0.0.1:15888`。
- 不导出公司子网，不配置出口代理；TCP/UDP 香港发现入口均 Connected。未重启电脑验证开机流程。
- 节点模板、清单及本地速查页已更新；线上速查页待发布，当前 Studio 缺中继 SSH 已信任主机密钥。

### Studio SSH 默认选路更新（2026-09-16）

`ssh nio-war-mac` 现在优先连接 EasyTier `10.10.10.14`；TCP 22 端口探测在2秒内不可达时，自动回退 Wi-Fi `10.9.1.230`。`nio-war-mac-mesh` 和 `nio-war-mac-wifi` 保留为固定路径入口。统一验证已信任的设备主机密钥，不绕过校验。默认连接实测远端地址为 `10.10.10.14`，强制局域网路径实测为 `10.9.1.230`。此设置只适用于 Studio 新建连接，既有会话断线需要重新连接。

### 2026-09-16 环境、清理及无头运行回执

- 设备现为 macOS 26.6.2，Swift 6.3.3，仅 CLT；项目源码仍为 v0.9.2 的非 Git 副本，但安装 App 已为 **v0.9.10 (25)**，不可用旧源码直接覆盖安装。
- 用户将用途补充为内部 POC、后续无头服务器；不安装代理，GitHub DNS 问题暂不处理。
- Clash Verge 应用/后台/自启动已清除；飞连解除文件保护后官方卸载成功，无相关进程及系统扩展；`/Applications/ChatGPT.app` 已删除。飞连仍有日志，未声称用户数据全部抹除。
- EasyTier 服务由 root 拥有，配置0600、目录0700；管理口仅回环。KeepAlive/RunAtLoad 开启，ThrottleInterval=30，Umask=63。日志每份1024 KiB轮转，保留3份。
- 实测终止进程后 launchd 自动重启（PID7054→7099），随后组网 SSH 成功。主动管理员停用/卸载仍可执行；未部署隐藏、反卸载、绕过管理员的机制。
- 电池和接电模式均设置 `disablesleep=1 sleep=0 disksleep=0 womp=1 tcpkeepalive=1`。原设置备份：目标机 `~/.local/state/nio-war-mac/power-before-headless-20260916.txt`。
- 用户合盖后实测 `AppleClamshellState=Yes`、`SleepDisabled=1`，EasyTier SSH 成功。当时电池69%，未接电；断电、断网或关机不保证远程可达。
- 用户要求的桌面远程维护说明已删除。当前 Studio 的 SSH 选路脚本归档于 `scripts/nio-war-mac-connect.sh`；本机实际使用 `~/.ssh/nio-war-mac-connect.sh`。

### 后续清理与工作流检查（2026-09-16）

- 已移除保存的 Wi-Fi `Amigo`、`BRO`，保留不同名称的 `iBRO` 和手机热点。
- 已删除 Keynote/Pages/Numbers Creator Studio、Lark 应用，清理 Codex缓存与飞连日志；Codex会话数据保留。清理后mesh SSH成功，磁盘约878 GiB可用。
- 安装版v0.9.10内置ProtoPie Cloud预览启动工作流；仅完成静态检查，等待接外屏联调。详见 [工作流检查记录](protopie-workflow-inspection-20260916.md)。

### 2026-09-18 鼠标映射版本

v0.12.0(35)已安装固定入口，新增ProtoPie Cloud鼠标映射与贴边热点；原8项配置语义保留，退出/紧急隐藏/失焦均恢复正常输入。捕获专用Chrome时排除隐藏工具栏子窗口，使有效纹理恢复7680×936。Air未改，新物理合盖周期与玻璃鼠标落点待用户现场体验。见[验收与回滚](mouse-mapping-v0120.md)。

### 2026-09-18 鼠标左右方向修正

v0.12.1(36)已替换固定安装版，仅反转玻璃观察模式的水平位移；用户原上下方向、校正和鼠标偏好保留。四向移动/点击/拖动/Esc实机软件验收通过，玻璃观感待用户复测；见[修复记录](mouse-horizontal-v0121.md)。
