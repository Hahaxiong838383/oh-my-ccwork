#!/bin/bash
# cc-remote V4 守护进程 安装/卸载/状态
# 用法：./install-daemon.sh [install|uninstall|status]

DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

case "${1:-install}" in
  install)
    echo "=== 安装 cc-remote V4 守护进程 ==="
    mkdir -p "$LAUNCH_DIR"

    # 先卸载旧的
    launchctl unload "$LAUNCH_DIR/cc-remote-v4.plist" 2>/dev/null || true
    launchctl unload "$LAUNCH_DIR/cc-remote-v4-frpc.plist" 2>/dev/null || true

    # 复制 plist
    cp "$DIR/cc-remote-v4.plist" "$LAUNCH_DIR/"
    cp "$DIR/cc-remote-v4-frpc.plist" "$LAUNCH_DIR/"

    # 加载
    launchctl load "$LAUNCH_DIR/cc-remote-v4-frpc.plist"
    echo "  ✓ frpc 守护已安装（KeepAlive + 开机自启）"

    launchctl load "$LAUNCH_DIR/cc-remote-v4.plist"
    echo "  ✓ V4 主服务已安装（开机自启）"

    echo ""
    echo "日志: /tmp/cc-remote-v4.log, /tmp/cc-remote-v4-frpc.log"
    echo "卸载: $0 uninstall"
    ;;

  uninstall)
    echo "=== 卸载 cc-remote V4 守护进程 ==="
    launchctl unload "$LAUNCH_DIR/cc-remote-v4.plist" 2>/dev/null || true
    launchctl unload "$LAUNCH_DIR/cc-remote-v4-frpc.plist" 2>/dev/null || true
    rm -f "$LAUNCH_DIR/cc-remote-v4.plist" "$LAUNCH_DIR/cc-remote-v4-frpc.plist"
    echo "  ✓ 已卸载"
    ;;

  status)
    echo "=== cc-remote V4 守护状态 ==="
    echo "frpc:"; launchctl list cc.remote.v4.frpc 2>/dev/null || echo "  未安装"
    echo "V4:"; launchctl list cc.remote.v4 2>/dev/null || echo "  未安装"
    echo "进程:"
    ps aux | grep -E 'frpc.*v4|ttyd -p 190|caddy run.*v4|api.py' | grep -v grep | awk '{print "  PID=" $2, $NF}' || echo "  无"
    ;;

  *)
    echo "用法: $0 [install|uninstall|status]"
    ;;
esac
