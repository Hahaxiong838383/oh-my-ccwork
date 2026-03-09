#!/bin/bash
# 卸载 mycc 后端守护进程
# 使用方法：./uninstall-daemon.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

LABEL="dev.mycc.backend"
PLIST_DEST="$HOME/Library/LaunchAgents/dev.mycc.backend.plist"

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}   卸载 mycc 后端守护进程${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

if [ ! -f "$PLIST_DEST" ]; then
  echo -e "${YELLOW}⚠ 未检测到已安装的守护进程${NC}"
  exit 0
fi

# 停止进程
echo -e "${YELLOW}▶ 停止守护进程...${NC}"
launchctl stop "$LABEL" 2>/dev/null || true
sleep 1

# 卸载 plist
echo -e "${YELLOW}▶ 卸载 plist...${NC}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST_DEST" 2>/dev/null || true
sleep 1

# 删除 plist
echo -e "${YELLOW}▶ 删除 plist 文件...${NC}"
rm -f "$PLIST_DEST"
echo -e "  ${GREEN}✓ 已删除 $PLIST_DEST${NC}"

# 确认进程已停
if lsof -Pi :18080 -sTCP:LISTEN -t >/dev/null 2>&1; then
  PID=$(lsof -Pi :18080 -sTCP:LISTEN -t)
  echo -e "${YELLOW}  端口 18080 仍被 PID=$PID 占用，强制 kill...${NC}"
  kill -9 "$PID" 2>/dev/null || true
  echo -e "  ${GREEN}✓ 已强制停止${NC}"
fi

echo ""
echo -e "${GREEN}✅ 守护进程已卸载，后端不会再自动启动${NC}"
echo ""
