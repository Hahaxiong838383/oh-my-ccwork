#!/bin/bash
# Xray Manager 一键安装脚本 (Linux / macOS 自适应)
set -e

XRAY_HOME="$HOME/xray"
XRAY_BIN="$XRAY_HOME/xray"
CONFIG_PATH="$XRAY_HOME/config.json"
LOG_PATH="$XRAY_HOME/xray.log"
MANAGER_PATH="$XRAY_HOME/xray-manager.py"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

echo "=============================="
echo "  Xray Manager 安装程序"
echo "  系统: $OS $(uname -m)"
echo "=============================="
echo ""

# 1. 创建目录
echo "📁 创建目录 $XRAY_HOME ..."
mkdir -p "$XRAY_HOME"

if [ "$OS" = "Darwin" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
else
    mkdir -p "$HOME/.config/systemd/user"
fi

# 2. 检查/安装 xray
if [ -f "$XRAY_BIN" ]; then
    echo "✅ Xray 已存在: $XRAY_BIN"
else
    echo "⬇️  下载 Xray-core ..."
    ARCH=$(uname -m)
    if [ "$OS" = "Darwin" ]; then
        if [ "$ARCH" = "arm64" ]; then
            XRAY_ARCH="darwin-arm64-v8a"
        else
            XRAY_ARCH="darwin-64"
        fi
    else
        if [ "$ARCH" = "x86_64" ]; then
            XRAY_ARCH="linux-64"
        elif [ "$ARCH" = "aarch64" ]; then
            XRAY_ARCH="linux-arm64-v8a"
        else
            echo "❌ 不支持的架构: $ARCH"
            exit 1
        fi
    fi
    XRAY_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-${XRAY_ARCH}.zip"
    echo "   下载地址: $XRAY_URL"
    curl -L -o /tmp/xray.zip "$XRAY_URL"
    unzip -o /tmp/xray.zip -d /tmp/xray-install
    cp /tmp/xray-install/xray "$XRAY_BIN"
    chmod +x "$XRAY_BIN"
    # 顺便把 geo 文件也从压缩包里拿出来
    for f in geoip.dat geosite.dat; do
        if [ -f "/tmp/xray-install/$f" ]; then
            cp "/tmp/xray-install/$f" "$XRAY_HOME/$f"
        fi
    done
    rm -rf /tmp/xray.zip /tmp/xray-install
    echo "✅ Xray 安装完成"
fi

# 3. 补全 geo 数据文件（如果压缩包里没有）
echo "📋 检查 GeoIP/GeoSite 数据文件 ..."
for f in geoip.dat geosite.dat; do
    if [ ! -f "$XRAY_HOME/$f" ]; then
        echo "  ⬇️  下载 $f ..."
        if [ "$f" = "geoip.dat" ]; then
            curl -L -o "$XRAY_HOME/$f" "https://github.com/v2fly/geoip/releases/latest/download/geoip.dat"
        else
            curl -L -o "$XRAY_HOME/$f" "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat"
        fi
        echo "  ✅ $f (已下载)"
    else
        echo "  ✅ $f (已存在)"
    fi
done

# 4. 复制配置文件
if [ ! -f "$CONFIG_PATH" ]; then
    if [ -f "$SCRIPT_DIR/config/config.json" ]; then
        echo "📋 复制默认配置 ..."
        cp "$SCRIPT_DIR/config/config.json" "$CONFIG_PATH"
        echo "✅ 配置已复制"
    else
        echo "⚠️  未找到配置模板，请手动创建 $CONFIG_PATH"
    fi
else
    echo "✅ 配置已存在: $CONFIG_PATH"
fi

# 5. 复制管理工具
echo "📋 安装管理工具 ..."
cp "$SCRIPT_DIR/xray-manager.py" "$MANAGER_PATH"
chmod +x "$MANAGER_PATH"
echo "✅ 管理工具已安装"

# 6. 配置开机自启服务
echo "⚙️  配置开机自启服务 ..."

if [ "$OS" = "Darwin" ]; then
    # macOS: launchd
    PLIST_NAME="com.xray.proxy"
    PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
    launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
    sed -e "s|__XRAY_BIN__|$XRAY_BIN|g" \
        -e "s|__CONFIG_PATH__|$CONFIG_PATH|g" \
        -e "s|__XRAY_HOME__|$XRAY_HOME|g" \
        -e "s|__LOG_PATH__|$LOG_PATH|g" \
        "$SCRIPT_DIR/service/com.xray.proxy.plist" > "$PLIST_PATH"
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
    echo "✅ launchd 服务已注册"
else
    # Linux: systemd user service
    SERVICE_PATH="$HOME/.config/systemd/user/xray.service"
    sed -e "s|__XRAY_BIN__|$XRAY_BIN|g" \
        -e "s|__CONFIG_PATH__|$CONFIG_PATH|g" \
        -e "s|__XRAY_HOME__|$XRAY_HOME|g" \
        -e "s|__LOG_PATH__|$LOG_PATH|g" \
        "$SCRIPT_DIR/service/xray.service" > "$SERVICE_PATH"
    systemctl --user daemon-reload
    systemctl --user enable xray.service
    systemctl --user restart xray.service
    echo "✅ systemd user 服务已注册并启动"
    # 确保用户服务在退出登录后仍运行
    loginctl enable-linger "$(whoami)" 2>/dev/null || true
fi

# 7. 添加 shell 快捷命令
if [ "$OS" = "Darwin" ]; then
    RCFILE="$HOME/.zshrc"
else
    RCFILE="$HOME/.bashrc"
fi
MARKER="# === Xray Manager ==="
if ! grep -q "$MARKER" "$RCFILE" 2>/dev/null; then
    echo ""
    echo "📝 添加快捷命令到 $RCFILE ..."

    if [ "$OS" = "Darwin" ]; then
        cat >> "$RCFILE" << 'ALIASES'

# === Xray Manager ===
alias xray-ui='python3 ~/xray/xray-manager.py'
alias xray-restart='launchctl kickstart -k gui/$(id -u)/com.xray.proxy'
alias xray-stop='launchctl kill SIGTERM gui/$(id -u)/com.xray.proxy'
alias xray-status='launchctl print gui/$(id -u)/com.xray.proxy 2>/dev/null | head -5; echo "---"; ps aux | grep "xray run" | grep -v grep'
alias xray-log='tail -50 ~/xray/xray.log'
alias xray-config='nano ~/xray/config.json'
# === End Xray Manager ===
ALIASES
    else
        cat >> "$RCFILE" << 'ALIASES'

# === Xray Manager ===
alias xray-ui='python3 ~/xray/xray-manager.py'
alias xray-restart='systemctl --user restart xray.service'
alias xray-stop='systemctl --user stop xray.service'
alias xray-status='systemctl --user status xray.service --no-pager; echo "---"; ps aux | grep "xray run" | grep -v grep'
alias xray-log='tail -50 ~/xray/xray.log'
alias xray-config='nano ~/xray/config.json'
# === End Xray Manager ===
ALIASES
    fi
    echo "✅ 快捷命令已添加"
fi

# 8. 等待 xray 启动
echo ""
echo "⏳ 等待 xray 启动 ..."
sleep 2

# 验证
if ps aux | grep -q "[x]ray run"; then
    PID=$(ps aux | grep "[x]ray run" | awk '{print $2}' | head -1)
    echo "✅ Xray 运行中 (PID: $PID)"
else
    echo "⚠️  Xray 未启动，查看日志: cat $LOG_PATH"
fi

echo ""
echo "=============================="
echo "  安装完成！"
echo "=============================="
echo ""
echo "快捷命令（重新打开终端后生效）："
echo "  xray-ui        启动 Web 管理界面"
echo "  xray-restart   重启 xray"
echo "  xray-status    查看状态"
echo "  xray-log       查看日志"
echo "  xray-config    编辑配置"
echo ""
echo "Web 管理界面: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1'):8888"
echo "SOCKS 代理:   127.0.0.1:10808"
echo ""
if [ "$OS" = "Darwin" ]; then
    echo "⚠️  记得在系统设置 → 网络 → Wi-Fi → 代理 中设置 SOCKS 代理为 127.0.0.1:10808"
else
    echo "⚠️  使用代理: export ALL_PROXY=socks5://127.0.0.1:10808"
fi
echo ""
