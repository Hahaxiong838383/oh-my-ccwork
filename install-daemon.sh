#!/bin/bash
# 安装 mycc 后端守护进程（launchd Launch Agent）
# 使用方法：./install-daemon.sh

set -e

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

CWD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$HOME"
USER_NAME="$(whoami)"
PLIST_NAME="dev.mycc.backend.plist"
PLIST_TEMPLATE="$CWD/.claude/skills/mycc/daemon/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"
RUN_SH="$CWD/.claude/skills/mycc/daemon/run.sh"
LABEL="dev.mycc.backend"

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}   安装 mycc 后端守护进程${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# 检查 macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}❌ 此脚本仅支持 macOS${NC}"
  exit 1
fi

# 确保 LaunchAgents 目录存在
mkdir -p "$HOME/Library/LaunchAgents"

# chmod run.sh
echo -e "${YELLOW}▶ 设置 run.sh 权限...${NC}"
chmod +x "$RUN_SH"
echo -e "  ${GREEN}✓ chmod +x run.sh${NC}"

# 如已加载，先 unload
if launchctl list | grep -q "$LABEL" 2>/dev/null; then
  echo -e "${YELLOW}▶ 检测到已安装旧版本，先卸载...${NC}"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST_DEST" 2>/dev/null || true
  sleep 1
fi

# sed 替换占位符，生成最终 plist
echo -e "${YELLOW}▶ 生成 plist 文件...${NC}"
sed \
  -e "s|__HOME__|$HOME_DIR|g" \
  -e "s|__CWD__|$CWD|g" \
  -e "s|__USER__|$USER_NAME|g" \
  "$PLIST_TEMPLATE" > "$PLIST_DEST"
echo -e "  ${GREEN}✓ 写入 $PLIST_DEST${NC}"

# 加载
echo -e "${YELLOW}▶ 加载守护进程...${NC}"
launchctl load -w "$PLIST_DEST"
echo -e "  ${GREEN}✓ launchctl load 完成${NC}"

# 等待启动
echo -e "${YELLOW}▶ 等待后端启动（最多 15s）...${NC}"
for i in $(seq 1 15); do
  sleep 1
  if lsof -Pi :18080 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PID=$(lsof -Pi :18080 -sTCP:LISTEN -t)
    echo -e "  ${GREEN}✓ 后端已启动，PID=$PID，端口 18080 监听中${NC}"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo -e "  ${YELLOW}⚠ 15s 内未检测到端口监听，请查看日志：${NC}"
    echo -e "     tail -f $CWD/.claude/skills/mycc/daemon.log"
  fi
done

echo ""
echo -e "${GREEN}✅ 守护进程已安装！${NC}"
echo ""
echo -e "  ${CYAN}常用命令：${NC}"
echo -e "  查看状态：  launchctl list | grep mycc"
echo -e "  查看日志：  tail -f .claude/skills/mycc/daemon.log"
echo -e "  临时停止：  ./stop-mycc.sh      （30s 内自动重启）"
echo -e "  永久卸载：  ./uninstall-daemon.sh"
echo ""
