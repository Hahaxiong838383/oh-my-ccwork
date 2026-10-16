# Air Grok Bot 应用专用代理

通过原版 App 的启动环境统一 Chromium 和 Node 原生网络请求，不修改应用包、签名、Keychain 或会话数据。

## 启动入口

双击同目录的 `grok-bot-lisa-launch.command`。启动器会校验并启动专用代理，再打开已安装的 `/Applications/Grok Bot.app`。

启动校验成功后，Apple Terminal 的单标签启动窗口会在 3 秒后自动关闭；按本次 TTY 和窗口 ID 定位，不关闭其他窗口，也不退出整个 Terminal。失败、仅准备配置或查看帮助时不安排关闭。多标签窗口、仍有任务的窗口及非 Apple Terminal 环境保留；若 macOS 未允许自动化控制 Terminal，自动关闭可能不执行，但不影响 App 启动。

应用已经通过该入口运行时不会重复启动。旧实例仍在运行时，只有在授权的维护窗口内才使用 `--restart`；正常结束旧进程，不强杀、不清理用户数据。

普通 Dock 原图标冷启动不保证携带这些代理环境变量；退出 App 后请通过此专用入口重新启动。

## 网络边界

- 主 Xray 与系统代理保持 `127.0.0.1:10808`，不重载、不改动其他应用的规则。
- App 专用 Xray 只监听 `127.0.0.1:10809`，标签 `grok-bot`。额外一个 Xray 进程是独立入口，并非争抢主端口。
- 启动器从主配置中 `domain:grok.com` 的固定出站生成专用配置。2026-10-14 验证为 `admin-LISA-ZGO-12443`，即 ZGO → 丽萨。
- App 的国外后端请求经专用节点；内网、localhost、个人 CPA 保留直连。禁用 Chromium QUIC，避免相关 UDP 请求绕过 HTTP 代理。
- 启动时设置 `NODE_USE_ENV_PROXY=1`、大小写 HTTP/HTTPS/ALL_PROXY，并显式传入 Chromium `--proxy-server`。
- 原版 Electron 42.1.0 包含该 Node 代理能力；不得为代理适配关闭应用安全 fuse、改 ASAR、重签名或设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- 若主 Grok 出站发生变化，重新运行启动器会同步专用配置。已经运行的旧连接不保证立即迁移，变更后须在维护窗口复验。
- 这不是 TUN 或应用全流量拦截：未遵循代理设置的原生连接仍可能直连。2026-10-14 现场仍观察到主进程有其他公网 TCP 连接，其用途未确认；不能将核心后端代理成功等同于所有流量均经丽萨。

## 运行文件

节点凭据仅保存在本机 `~/xray/grok-bot-proxy.json`（600），不进入 Git 或记忆。

LaunchAgent：`~/Library/LaunchAgents/com.mycc.grok-bot.proxy.plist`；专用代理随用户登录启动，但不会自动启动 Grok Bot App。

运行日志：`~/xray/grok-bot-proxy.log`；路由证据：`~/xray/grok-bot-proxy-access.log`，均为 600。

## 验收与回退

需要同时核对 App 主进程/Helper 的 `:10809` 连接、最新 `grok-bot → 目标节点` 访问日志、账户与 Bot 列表正常刷新；HTTP 200 或启动参数本身不是聊天/远程桌面的完整验收。

2026-10-14 已完成授权重启并迁移至常驻 LaunchAgent；`api2.cursor.sh`、`api3.cursor.sh`、`*.cursorvm.com` 的实际请求命中 `admin-LISA-ZGO-12443`。专用出口探测为丽萨，Grok 首页及 Bot 后端 HTTP 200，界面不再显示“无法刷新”或“连接中”。未发送测试消息，也未操作远程桌面，完整工作流仍须用户验收。

主 Xray 未改动或重启。回归探测 Google HTTP 204；OpenAI 官方接口出现 TLS 超时与未认证 HTTP 401 交替，原链路仍有间歇波动，不属于本次专用代理的已修复范围。

回退时先正常退出 App，再停用 `gui/$(id -u)/com.mycc.grok-bot.proxy`，从原版 App 图标启动。主配置与系统代理不用回退。保留专用配置供复核；不要触碰 `sand-secrets.json`、Cookies、会话存储或 Keychain。

## 2026-10-16 复发与更新边界

- 14:49 左右现场：网页版正常，App 显示“无法刷新”；当前 App 主进程缺少 `NODE_USE_ENV_PROXY=1`，环境指向主入口 10808，核心后端 TCP 直连停在 SYN_SENT，未使用专用入口。
- 同期 `api2.cursor.sh` 三轮对照：直连 0/3（TCP 超时），10809 为 3/3 HTTP 200；10808 为 2/3，另一次 TLS 超时。只能证明该窗口专用链路可用，不能宣布整体网络长期稳定。
- 14:52 经用户明确授权，仅通过现有启动器 `--restart` 重启 App。参数恢复、核心后端日志重新命中 `admin-LISA-ZGO-12443`，界面“无法刷新”消失并加载此前未显示的对话；未发送测试消息、未修改节点或主 Xray。
- 直接故障机制是该实例未启用 Node 环境代理并绕行直连；究竟由普通图标启动还是更新器重启引起，未取证，不能归因给更新器。

用户选择暂时保留现有启动方式：完全退出后双击本目录 `.command`；App 正常运行时原 Dock 图标仅用于唤起。更新器自动重启后复核代理，必要时结束当前操作、正常退出，再用专用启动器打开。启动器位于应用包外不代表任何启动路径都受控；未新增自动守护、Dock 替换、TUN 或永久代理保证。
