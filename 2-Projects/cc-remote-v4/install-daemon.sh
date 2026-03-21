#!/bin/bash
# 安装 cc-remote 为 launchd daemon（开机自启）
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$DIR/cc-remote.plist"
TARGET="$HOME/Library/LaunchAgents/dev.cc-remote.plist"

# 先卸载旧的
launchctl unload "$TARGET" 2>/dev/null || true

# 复制 plist
cp "$PLIST" "$TARGET"
echo "✓ 已安装: $TARGET"

# 加载
launchctl load "$TARGET"
echo "✓ 已加载 dev.cc-remote daemon"
echo ""
echo "管理命令:"
echo "  查看状态: launchctl list | grep cc-remote"
echo "  查看日志: tail -f /tmp/cc-remote.log"
echo "  停止:     launchctl unload $TARGET"
echo "  启动:     launchctl load $TARGET"
