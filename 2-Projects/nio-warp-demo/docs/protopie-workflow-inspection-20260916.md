# NIO Warp / ProtoPie 工作流检查（2026-09-16）

状态：只读检查完成，等待后续联调；本次未启动演示、修改 App 或部署代码。

## 设备上的实际入口

- 设备：nio-war-mac，组网名称“nio 开发机”，SSH `nio-war-mac`（Studio：mesh 优先、局域网回退）。
- 桌面 `/Users/futurus/Desktop/NIO Warp.command` 是项目 `start-native-warp.command` 的符号链接；脚本直接执行固定安装版二进制。
- 安装位置：`/Users/futurus/Applications/NIOWarpApp.app`。
- 当前安装版本：**0.9.10 (25)**。
- Bundle 源码指纹：`0f5a54b912037d327dcd7d01ef3b064d2848bb7a5cd21a89fd2737b43ef34933`。
- Info.plist 中 `NIOWarpProtoPieBootstrapEnabled=true`，未查到用户偏好覆盖值。
- 设备项目目录仍是 v0.9.2 非 Git 副本；Studio 当前源码也仅补齐到 v0.9.2。尚未找到 v0.9.10 对应源码，不得用旧源码覆盖安装版。

## 安装包检查确认的工作流

安装包包含 `Contents/Resources/position-chrome.py`，二进制包含 ProtoPieBootstrapper 及 Chrome 启动参数。结合助手脚本与历史捕获记录，流程为：

1. 使用演示专用 Chrome 配置目录 `/tmp/nio-protopie-app-profile-v1`，本机 CDP 端口 `127.0.0.1:9223`。
2. 打开 ProtoPie Cloud 项目 `https://cloud.protopie.io/p/321d8a5e852d7a12cda9d149`。URL 参数配置隐藏 UI、scaleToFit、黑色背景等。
3. 助手要求页面标题精确等于 `test1 | ProtoPie Cloud`，且至少一张图片加载完成、尺寸不小于 3000×400。
4. 通过 CDP 设置窗口位置 `left=-1089, top=-1040, width=1900, height=1030`，并读取窗口尺寸验证一致。
5. Warp 捕获该窗口。历史 UserDefaults 捕获摘要为 Chrome / test1 / 3800×2060；不是本轮实时捕获证据。

二进制包含禁用遮挡后台化和后台计时器节流参数。未取得当前版本完整源码，无法仅凭字符串确认所有重试、焦点处理及异常分支。

这是云端浏览器播放工作流，不是自动打开 ProtoPie 编辑器或桌面 `test1.pie`。

## 旧入口与当前现场

- 旧桌面脚本 `/Users/futurus/Desktop/启动ProtoPie弯曲全屏.command` 仍存在：使用 `/tmp/nio-protopie-kiosk-profile`，先重启专用 Chrome，最多等待90轮标题匹配，再用 AppleScript 设置窗口，最后重启 Warp。
- 两套入口共用9223端口但使用不同配置目录；旧脚本与 App 内置流程可能冲突，后续应统一入口。
- 未发现遗留 Warp 自启动 LaunchAgent。
- 本轮没有 NIOWarpApp 或 ProtoPie 运行进程；CDP `/json/list` 返回空列表。
- `nioWarpRuntimeProtoPieBootstrap=ready` 是保存状态，不能据此认定当前预览就绪。
- 仅检测到内置3024×1964屏幕，无外屏；未做实际输出或键盘交互验收。

## 后续联调

1. 找回并确认 v0.9.10 源码和构建来源，先保全当前可用安装版。
2. 接回目标外屏，确认屏幕布局与硬编码负坐标匹配。
3. 验证 ProtoPie Cloud 可访问，再从 `NIO Warp.command` 冷启动。
4. 分别核验预览页面加载、Chrome窗口位置、Warp捕获摘要、实屏画面和键盘交互。
5. 核实新版入口可用后处理旧启动脚本；此前不删除。
