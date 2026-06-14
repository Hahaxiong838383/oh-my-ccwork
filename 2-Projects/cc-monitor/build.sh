#!/usr/bin/env bash
# 编译 cc-monitor.swift 并打包成 cc-monitor.app（菜单栏代理 app）
set -euo pipefail
cd "$(dirname "$0")"
APP="cc-monitor.app"

echo "→ 编译"
swiftc -swift-version 5 -parse-as-library cc-monitor.swift -o cc-monitor

echo "→ 组装 .app bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp cc-monitor "$APP/Contents/MacOS/cc-monitor"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>cc-monitor</string>
  <key>CFBundleDisplayName</key><string>cc 监视器</string>
  <key>CFBundleIdentifier</key><string>com.chuange.cc-monitor</string>
  <key>CFBundleExecutable</key><string>cc-monitor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
echo "✅ 完成: $(pwd)/$APP"
echo "   启动: open $APP   |   退出: 点菜单栏 cc 图标→退出"
