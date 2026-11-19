# nio-war-mac v0.11.1 安装与验收

2026-09-17，Air 用户体验通过后，已将 **NIO Warp v0.11.1 (28)** 安装到开发机。无外屏条件下的界面、退出确认、ProtoPie 云端页面验收通过；外屏捕获首帧及实际 Warp 输出按用户安排待接屏后补验。

## 版本与来源

| 项目 | 结果 |
|---|---|
| 设备 | `nio-war-mac` / `futurus`，macOS 26.6.2；SSH 实测经 EasyTier `10.10.10.14` |
| 安装位置 | `/Users/futurus/Applications/NIOWarpApp.app` |
| 升级 | 原定制 v0.9.10 (25) → v0.11.1 (28) |
| 功能源提交 | `d87db4178b68fecf4a91136bd751b380819c4adc` |
| 用户验收提交 | `658d551c6c1639b4fd5ed06f3a3bdf3735ea3c12` |
| 验收标签 | `nio-warp-v0.11.1-accepted-20260917`，已推送 origin |
| 源码指纹 | `98eac0d9c6917628cd89fc0b3aae12bb82c2560df75a3c54caca3cfbd5f0fbbc` |
| 传输 ZIP SHA256 | `74f7fb14cb62aefefc64c51bab8a34af859139c15a1e7b1a9709c18ebc01e140` |
| 安装后二进制 SHA256 | `8fb1e406d528f90e03cf5537970792e334362a5363ee5814b9fe12ca14160f69` |

使用 Air 同源、21项针对性回归通过的冻结包。开发机无 Apple Development 身份，沿用原应用 ad-hoc 签名及稳定要求 `designated => identifier "com.mycc.nio-warp-demo"`；非空新旧要求一致，安装后严格签名验证通过。未修改 TCC、钥匙串或导入 Air 校正参数。

源目录 `/Users/futurus/mycc/2-Projects/nio-warp-demo` 也已对齐验收提交：87文件逐项校验，44项新增或更新，其中33项为新增；排除 `.git`、`.rollback`、`artifacts`，未删除额外文件。仍为非 Git 开发副本，以 `.deployed-source.json` 记录来源。设备重新计算源码指纹与安装 App 一致，隔离 release 构建通过（35.76秒），没有用验证构建再次覆盖安装版。

开发机只有 CLT、缺少 XCTest，本次未在该机宣称测试套件通过。可复用的软件证据为本补丁 Air 相关21/21及此前 v0.11.0 全套197/197，见[退出补丁](quit-confirmation-v0111.md)和[工作台验收](workbench-acceptance-20260917.md)。

## 参数与 ProtoPie 迁移

- 原两份校正配置、预设、历史及最后显示器选择共5个数据键，安装、启动、实际退出重启及界面操作后完全一致；最终磁盘偏好中全部旧键均未改变。XML 导出会舍去旧诊断日期的小数秒，不计为参数变化。
- 从旧安装版提取完整云端项目 URL，并保留全部参数；URL SHA256 为 `217cda9f988878f9023329745729efbc11e048b0c35bbba48f3a05e97a0333c5`。
- 迁移到 `nioWarpProtoPie.configuration.v1` / `draft.v1`，来源 Cloud，自动启动和自动恢复开启；未制造 `lastSuccessful.v1`，无捕获首帧时仍不存在该记录。
- 新播放器使用 `~/Library/Application Support/NIOWarp/ProtoPieChrome` 专用 profile。旧 Chrome、旧 `/tmp/nio-protopie-app-profile-v1`、桌面 `.pie` 和旧全屏脚本保留，没有复制 Cookie 或覆盖本地原型。
- 日常入口仍为桌面 `NIO Warp.command`，调用固定安装 App。旧“启动ProtoPie弯曲全屏.command”属于另一套历史工作流，本次未改动。

## 实际验收

用户解锁后通过 AX 实际点击，并用 CDP 检查本次专用播放器。

| 检查 | 结果 |
|---|---|
| 窗口版本 | `NIO Warp 工作台 · v0.11.1 (28)` |
| 六模块 | 画布与输入、整体校正、局部微调、标定与画质、预设与历史、ProtoPie 联动；最后一项在最右 |
| 单窗口 | 逐项切换始终1个工作台窗口 |
| 无外屏保护 | 校正相关输入只读，ProtoPie 配置可编辑 |
| 顶部退出 | 弹出二次确认；取消保留原 PID16881；再次确认后进程退出，固定路径重启为 PID17378 |
| 自动启动 | 重启后为“等待目标外屏”，没有虚报正在捕获 |
| 停止与重试 | 停止显示“已停止”，重试恢复“等待目标外屏” |
| 手动打开播放器 | 新专用 Chrome 窗口成功创建，URL 与旧项目及参数一致 |
| 云端实际内容 | DNS 恢复后加载 `test1 \| ProtoPie Cloud`，document complete；两张3840×1080原型图片完整加载，无错误页或登录提示 |
| 画面目视 | 截图确认道路、车速80、导航、停车内容可见 |
| 验收后参数 | 上述5个保护键不变，旧偏好键磁盘值均不变 |

验收结束保留 App 运行，ProtoPie 状态为“等待目标外屏”。当前只有内屏 Color LCD；用户明确暂时不接外屏，因此以下未验：真实外屏捕获首帧、Warp 输出及外屏热插拔恢复、本地 `.pie` 切换、光学效果与长期稳定性。云端页面可见不等于外屏联动整条链已通过。

## 网络故障修复

首轮播放器报 `ERR_INTERNET_DISCONNECTED`：Wi-Fi 静态地址与局域网仍工作，但 DNS 配置为空，`scutil --nwi` 无可用 IPv4 状态、普通查询无全局路由，所有公网域名解析失败。

备份后仅执行 `networksetup -setdnsservers Wi-Fi 223.5.5.5 223.6.6.6`，恢复设备此前登记的 DNS。系统随后恢复 IPv4/DNS Reachable 和默认选路，经 `en0 → 10.9.1.254`；无代理 curl 到 ProtoPie Cloud 返回 HTTP200，专用播放器重载后的实际项目资源正常。

静态 IP `10.9.1.230/24`、网关、服务顺序与 EasyTier 配置未改，mesh SSH复核通过。没有新增代理或手写路由。DNS 清空原因本次未确定。

网络备份：`/Users/futurus/.local/state/nio-war-mac/network-20260917-v0111`，含原 SystemConfiguration 偏好、接口/DNS/路由状态及 `network-recovery.json`。只撤销本次 DNS 恢复可用 `networksetup -setdnsservers Wi-Fi Empty`，但会恢复本次排查前的不完整配置，不建议作为日常设置。

## 配对回滚

开发机目录：`/Users/futurus/mycc/2-Projects/nio-warp-demo/.rollback/app-installs/20260917-024025Z-before-v0111`。

| 文件 | SHA256 |
|---|---|
| `NIOWarpApp-v0.9.10-25.zip` | `cc6741e20afe01cb587b491b1fa7a208b029e182c4f367d48a375887f24cf688` |
| `preferences-before.plist` | `c504dfbdff33e3c0121b28f2a5ce7484fffe729e52e7ff11a211eb26d7e56cad` |
| `NIOWarpApp-v0.11.1-28-signed.zip` | `78ca521a3df21256ad029fcd2596e6f0311428ea3ce660f1a66869beb0aee18f` |
| `source-files-before.tar.gz` | `417b9a55547e223b9ab8a286cdb279d17cbc305a4f8fadd942309ad8d4948847` |

旧/新 App 与偏好均已回读校验；备份中还有原签名、迁移回执及启动/界面验收后的偏好。回滚前正常退出 App，另存最新参数，再恢复配对旧 App 与偏好。源文件回退使用 `source-files-before.tar.gz` 和 `source-created-paths.json`，只处理此次改动；禁止对整个 mycc 执行 reset/clean。验收源码归档 SHA256 为 `b7243b280a2bab38c52854271d41d8333ff39bfae48ade7656040ca36caec7a4`，与 Air 固化快照相同。

最初安装任务因无法读取桌面历史脚本而在覆盖 App 前停止；保留该脚本不动后安装成功。临时安装 LaunchAgent 已移除。

本机原始证据目录 `artifacts/dev-v0111-install-20260917/`（不提交用户参数/二进制）：`ui-acceptance-result.json`、`post-ui-comparison.json`、`source-sync.json`、`network-recovery.json`、构建/安装日志、DOM与各阶段AX记录。实际云端截图 `protopie-live-page-after-network.png` SHA256：`134b73a0f650e36a5c326a1309ef400e17e0863ed4c547eb9e7d7a77972fc2ad`。

署名：codex（OpenAI）| 2026-09-17（Asia/Shanghai）
