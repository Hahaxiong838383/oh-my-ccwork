#!/bin/bash
# Xray Manager 一键安装脚本 (Linux)
# 适用于飞牛 NAS、Ubuntu、Debian 等 Linux 发行版
set -e

XRAY_HOME="$HOME/xray"
XRAY_BIN="$XRAY_HOME/xray"
CONFIG_PATH="$XRAY_HOME/config.json"
LOG_PATH="$XRAY_HOME/xray.log"
SERVICE_NAME="xray-proxy"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_PATH="$SYSTEMD_DIR/$SERVICE_NAME.service"
MANAGER_PATH="$XRAY_HOME/xray-manager.py"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=============================="
echo "  Xray Manager 安装程序 (Linux)"
echo "=============================="
echo ""

# 1. 创建目录
echo "[1/8] 创建目录 $XRAY_HOME ..."
mkdir -p "$XRAY_HOME"
mkdir -p "$SYSTEMD_DIR"

# 2. 检查/安装 xray
echo "[2/8] 检查 xray ..."
if [ -f "$XRAY_BIN" ]; then
    echo "  已存在: $XRAY_BIN"
else
    echo "  下载 Xray-core ..."
    ARCH=$(uname -m)
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        XRAY_ARCH="linux-arm64-v8a"
    elif [ "$ARCH" = "x86_64" ]; then
        XRAY_ARCH="linux-64"
    else
        echo "  [!] 不支持的架构: $ARCH"
        exit 1
    fi
    XRAY_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-${XRAY_ARCH}.zip"
    TMP_DIR=$(mktemp -d)
    curl -L -o "$TMP_DIR/xray.zip" "$XRAY_URL"
    unzip -o "$TMP_DIR/xray.zip" -d "$TMP_DIR/xray-install"
    cp "$TMP_DIR/xray-install/xray" "$XRAY_BIN"
    chmod +x "$XRAY_BIN"
    rm -rf "$TMP_DIR"
    echo "  xray 安装完成"
fi

# 3. 复制 geo 数据文件
echo "[3/8] 复制 GeoIP/GeoSite 数据文件 ..."
for f in geoip.dat geosite.dat; do
    if [ ! -f "$XRAY_HOME/$f" ]; then
        # 先从安装包复制
        if [ -f "$SCRIPT_DIR/$f" ]; then
            cp "$SCRIPT_DIR/$f" "$XRAY_HOME/$f"
            echo "  $f (从安装包复制)"
        else
            echo "  下载 $f ..."
            if [ "$f" = "geoip.dat" ]; then
                curl -L -o "$XRAY_HOME/$f" "https://github.com/v2fly/geoip/releases/latest/download/geoip.dat"
            else
                curl -L -o "$XRAY_HOME/$f" "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat"
            fi
            echo "  $f (已下载)"
        fi
    else
        echo "  $f (已存在)"
    fi
done

# 4. 复制配置文件
echo "[4/8] 复制配置文件 ..."
if [ ! -f "$CONFIG_PATH" ]; then
    if [ -f "$SCRIPT_DIR/config/config.json" ]; then
        cp "$SCRIPT_DIR/config/config.json" "$CONFIG_PATH"
        echo "  配置已复制"
    elif [ -f "$SCRIPT_DIR/config/config.json.example" ]; then
        cp "$SCRIPT_DIR/config/config.json.example" "$CONFIG_PATH"
        echo "  示例配置已复制（请编辑添加你的节点）"
    else
        echo "  [!] 未找到配置文件，请手动复制到 $CONFIG_PATH"
    fi
else
    echo "  配置已存在: $CONFIG_PATH"
fi

# 5. 复制管理工具
echo "[5/8] 安装管理工具 ..."
cp "$SCRIPT_DIR/xray-manager.py" "$MANAGER_PATH"
chmod +x "$MANAGER_PATH"
echo "  管理工具已安装"

# 6. 配置 systemd 用户服务
echo "[6/8] 配置 systemd 用户服务 ..."
if [ -f "$SCRIPT_DIR/service/xray-proxy.service" ]; then
    cp "$SCRIPT_DIR/service/xray-proxy.service" "$SERVICE_PATH"
else
    # 内联生成 service 文件
    cat > "$SERVICE_PATH" << EOF
[Unit]
Description=Xray Proxy Service
After=network.target

[Service]
ExecStart=$XRAY_BIN run -c $CONFIG_PATH
WorkingDirectory=$XRAY_HOME
StandardOutput=append:$LOG_PATH
StandardError=append:$LOG_PATH
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
fi
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" 2>/dev/null || true
systemctl --user restart "$SERVICE_NAME"
echo "  systemd 用户服务已注册并启动"

# 7. 配置代理环境变量
echo "[7/8] 配置代理环境变量 ..."
BASHRC="$HOME/.bashrc"
MARKER="# === Xray Manager ==="
if ! grep -q "$MARKER" "$BASHRC" 2>/dev/null; then
    cat >> "$BASHRC" << 'ALIASES'

# === Xray Manager ===
export http_proxy=http://127.0.0.1:20171
export https_proxy=http://127.0.0.1:20171
export no_proxy=localhost,127.0.0.1
alias xray-ui='python3 ~/xray/xray-manager.py'
alias xray-restart='systemctl --user restart xray-proxy'
alias xray-stop='systemctl --user stop xray-proxy'
alias xray-status='systemctl --user status xray-proxy --no-pager; echo "---"; ps aux | grep "xray run" | grep -v grep'
alias xray-log='tail -50 ~/xray/xray.log'
alias xray-config='nano ~/xray/config.json'
# === End Xray Manager ===
ALIASES
    echo "  环境变量和快捷命令已添加到 ~/.bashrc"
else
    echo "  快捷命令已存在"
fi

# 8. 验证
echo "[8/8] 验证 ..."
sleep 2

if systemctl --user is-active "$SERVICE_NAME" >/dev/null 2>&1; then
    echo "  Xray 服务运行中"
elif ps aux | grep -q "[x]ray run"; then
    PID=$(ps aux | grep "[x]ray run" | awk '{print $2}' | head -1)
    echo "  Xray 运行中 (PID: $PID)"
else
    echo "  [!] Xray 未启动，查看日志: cat $LOG_PATH"
fi

echo ""
echo "=============================="
echo "  安装完成！"
echo "=============================="
echo ""
echo "快捷命令（重新打开终端或 source ~/.bashrc 后生效）："
echo "  xray-ui         启动 Web 管理界面"
echo "  xray-restart     重启 xray"
echo "  xray-stop        停止 xray"
echo "  xray-status      查看状态"
echo "  xray-log         查看日志"
echo "  xray-config      编辑配置"
echo ""
echo "代理端口："
echo "  SOCKS 代理:  127.0.0.1:10808"
echo "  HTTP 代理:   127.0.0.1:20171"
echo "  Web 管理 UI: http://127.0.0.1:8888"
echo ""
echo "环境变量已设置 http_proxy/https_proxy 指向 HTTP 代理 (20171)"
echo "CLI 工具 (claude, npm, curl 等) 将自动使用此代理"
echo ""
