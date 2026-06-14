# cc-monitor — cc 系统状态监视器

菜单栏图标 + 状态/架构面板，实时显示 cc 运行架构状态。2026-06-14 建（arch-v1 配套）。

## 两个能用的版本

| 版本 | 源码 | 形态 | 构建 | 状态 |
|---|---|---|---|---|
| **菜单栏版**（主推） | `cc-monitor-menubar.swift` | 顶栏图标，点击弹面板 | `build-menubar.sh`（Xcode 真签名） | ✅ |
| **Dock 版**（备选） | `cc-monitor-dock.swift` | Dock 图标，点击开窗口 | `swiftc`（见下） | ✅ |
| ~~MenuBarExtra 版~~ | `cc-monitor.swift` | — | — | ❌ 废弃：SwiftUI `MenuBarExtra` 在 macOS 26 此环境不渲染图标，保留作对照 |

## 显示什么

- **状态 tab**：常驻预算（rules/MEMORY/events 进度条，绿=健康/橙=超软绊线）、记忆卡数、MCP/session、git、引擎团队亮灯
- **架构 tab**：5 层架构（常驻核心 → 按需召回 → 项目 ~/mycc → 引擎团队 → 隐私墙）+ **每层真实目录路径，点路径在 Finder 打开**
- 图标：健康=仪表盘 / 异常=⚠️（SF Symbol 解析为 nil 时 fallback 纯文字 `✦cc`）

数据源 `~/.claude/hooks/cc-status.sh --json`。实时机制：**FSEvents 监听 rules/memory/git/events 目录 + 3s 轮询兜底 + 关面板自动暂停（后台零开销）**。

## 构建 + 启动

**菜单栏版**：
```bash
bash build-menubar.sh
# ⚠️ 启动必须你【自己】跑 —— 自动化/cc 代跑会进不可见的 GUI 会话，图标你看不到：
open cc-monitor.app
```

**Dock 版**（不涉及菜单栏渲染坑，swiftc 直接编）：
```bash
swiftc -swift-version 5 cc-monitor-dock.swift -o cc-monitor-dock
# 打包 .app 同理（Dock 版无沙盒/签名要求，ad-hoc 即可）
```

## 开机自启

系统设置 → 通用 → 登录项 → **+** → 选 `cc-monitor.app`。
（登录项 = 你的 GUI 会话启动，所以图标稳；不建议 LaunchAgent，daemon 会话同样看不到图标。）

## 图标位置

macOS **不允许** app 用代码把图标钉到指定位置。按住 **Cmd 拖动**图标到顺手处，源码里的 `autosaveName` 会记住，下次启动复原。最右是系统保留区（控制中心/时钟/Spotlight），第三方图标只能排在其左侧。

## 三个真根因（踩了一晚上，别再犯）

1. **启动会话**：cc/自动化 `open`/`open_application` 启动的 GUI app 进**不可见会话**，菜单栏图标本人看不到（窗口却能跨会话显示，所以 Dock 版当时没暴露这个）→ 必须**用户手动**启动。
2. **App Sandbox**：Xcode 26 新建 macOS app 默认 `ENABLE_APP_SANDBOX=YES`，沙盒挡死 `Process` 跑 `cc-status.sh` + 读 `~/.claude` + 把 `/tmp` 写重定向进容器（症状：数据全 0 + 调试日志凭空消失）→ pbxproj 已设 `ENABLE_APP_SANDBOX=NO`。
3. **Debug dylib**：Xcode 26 Debug 把代码塞进 `cc-monitor.debug.dylib`（路径绑定，ditto 到别处即废）→ 必须 `-configuration Release`（自包含）。
4. 附：SwiftUI `MenuBarExtra` 不渲染 → 改用 AppKit `NSStatusItem`；`gauge.medium` 等 SF Symbol 可能 nil → 加纯文字 fallback。

## 技术

AppKit `NSStatusItem` + `NSPopover` + SwiftUI `ContentView`（`NSHostingController`）。Xcode 工程在 `xcode/`，pbxproj 已固化 `sandbox=NO` + `LSUIElement`。免费 Apple ID 自动签名即可本地运行。
