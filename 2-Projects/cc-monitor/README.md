# cc-monitor — cc 系统状态悬浮监视器

菜单栏图标 + 桌面悬浮面板，实时显示 cc 运行架构状态。2026-06-14 建（架构迁移 arch-v1 配套）。

## 显示什么
- **常驻预算**：rules / MEMORY / events 进度条（绿=健康，橙=超软绊线）
- **记忆**：canonical 卡片数 + secret 闸状态
- **git**：~/.claude 干净/未提交 + tag
- **引擎团队**：omp / grok / codex / gemini / gateway 亮灯
- **MCP / session** 数

数据源：`~/.claude/hooks/cc-status.sh --json`，每 30s 轮询。

## 用法
```bash
bash build.sh        # 编译 + 打包 cc-monitor.app
open cc-monitor.app  # 启动（菜单栏出现 "cc ●" 绿点=健康 / "cc ▲" 橙=有告警）
```
- 点菜单栏 **cc** 图标 → 弹出/收起悬浮面板（面板可拖动、always-on-top）
- 面板内「刷新」立即更新，「退出」关闭 app

## 开机自启（可选，standing config，需你确认）
```bash
cp com.chuange.cc-monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chuange.cc-monitor.plist
# 取消自启：launchctl unload ... && rm ...
```
或：系统设置 → 通用 → 登录项 → 加 cc-monitor.app。

## 技术
单文件 SwiftUI（AppKit 壳：NSStatusItem 菜单栏 + NSPanel 悬浮窗），`swiftc -swift-version 5` 编译，无运行时依赖。源码 `cc-monitor.swift`。
