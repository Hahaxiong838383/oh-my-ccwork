#!/bin/bash
# Xray Manager 一键安装脚本 (macOS)
set -e

XRAY_HOME="$HOME/xray"
XRAY_BIN="$XRAY_HOME/xray"
CONFIG_PATH="$XRAY_HOME/config.json"
LOG_PATH="$XRAY_HOME/xray.log"
PLIST_NAME="com.xray.proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
MANAGER_PATH="$XRAY_HOME/xray-manager.py"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=============================="
echo "  Xray Manager 安装程序"
echo "=============================="
echo ""

# 1. 创建目录
echo "📁 创建目录 $XRAY_HOME ..."
mkdir -p "$XRAY_HOME"
mkdir -p "$HOME/Library/LaunchAgents"

# 2. 检查/安装 xray
if [ -f "$XRAY_BIN" ]; then
    echo "✅ Xray 已存在: $XRAY_BIN"
else
    # 尝试从 V2RayN 复制
    V2RAYN_XRAY="$HOME/Library/Application Support/v2rayN/bin/xray/xray"
    if [ -f "$V2RAYN_XRAY" ]; then
        echo "📋 从 V2RayN 复制 xray ..."
        cp "$V2RAYN_XRAY" "$XRAY_BIN"
        chmod +x "$XRAY_BIN"
    else
        echo "⬇️  下载 Xray-core ..."
        ARCH=$(uname -m)
        if [ "$ARCH" = "arm64" ]; then
            XRAY_ARCH="darwin-arm64-v8a"
        else
            XRAY_ARCH="darwin-64"
        fi
        XRAY_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-${XRAY_ARCH}.zip"
        curl -L -o /tmp/xray.zip "$XRAY_URL"
        unzip -o /tmp/xray.zip -d /tmp/xray-install
        cp /tmp/xray-install/xray "$XRAY_BIN"
        chmod +x "$XRAY_BIN"
        rm -rf /tmp/xray.zip /tmp/xray-install
    fi
    echo "✅ Xray 安装完成"
fi

# 3. 复制 geo 数据文件
echo "📋 复制 GeoIP/GeoSite 数据文件 ..."
V2RAYN_BIN="$HOME/Library/Application Support/v2rayN/bin"
for f in geoip.dat geosite.dat; do
    if [ ! -f "$XRAY_HOME/$f" ]; then
        if [ -f "$V2RAYN_BIN/$f" ]; then
            cp "$V2RAYN_BIN/$f" "$XRAY_HOME/$f"
            echo "  ✅ $f (从 V2RayN 复制)"
        else
            echo "  ⬇️  下载 $f ..."
            if [ "$f" = "geoip.dat" ]; then
                curl -L -o "$XRAY_HOME/$f" "https://github.com/v2fly/geoip/releases/latest/download/geoip.dat"
            else
                curl -L -o "$XRAY_HOME/$f" "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat"
            fi
            echo "  ✅ $f (已下载)"
        fi
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
        echo "⚠️  未找到配置文件，请手动复制到 $CONFIG_PATH"
    fi
else
    echo "✅ 配置已存在: $CONFIG_PATH"
fi

# 5. 复制管理工具
echo "📋 安装管理工具 ..."
cp "$SCRIPT_DIR/xray-manager.py" "$MANAGER_PATH"
chmod +x "$MANAGER_PATH"
echo "✅ 管理工具已安装"

# 6. 配置 launchd 服务
echo "⚙️  配置开机自启服务 ..."
# 先卸载已有服务
launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true

# 生成 plist（替换占位符）
sed -e "s|__XRAY_BIN__|$XRAY_BIN|g" \
    -e "s|__CONFIG_PATH__|$CONFIG_PATH|g" \
    -e "s|__XRAY_HOME__|$XRAY_HOME|g" \
    -e "s|__LOG_PATH__|$LOG_PATH|g" \
    "$SCRIPT_DIR/service/com.xray.proxy.plist" > "$PLIST_PATH"

# 加载服务
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "✅ launchd 服务已注册"

# 7. 添加 shell 快捷命令
ZSHRC="$HOME/.zshrc"
MARKER="# === Xray Manager ==="
if ! grep -q "$MARKER" "$ZSHRC" 2>/dev/null; then
    echo ""
    echo "📝 添加快捷命令和代理环境变量到 ~/.zshrc ..."
    cat >> "$ZSHRC" << 'ALIASES'

# === Xray Manager ===
export http_proxy=http://127.0.0.1:20171
export https_proxy=http://127.0.0.1:20171
export no_proxy=localhost,127.0.0.1
alias xray-ui='python3 ~/xray/xray-manager.py'
alias xray-restart='launchctl kickstart -k gui/$(id -u)/com.xray.proxy'
alias xray-stop='launchctl kill SIGTERM gui/$(id -u)/com.xray.proxy'
alias xray-status='launchctl print gui/$(id -u)/com.xray.proxy 2>/dev/null | head -5; echo "---"; ps aux | grep "xray run" | grep -v grep'
alias xray-log='tail -50 ~/xray/xray.log'
alias xray-config='nano ~/xray/config.json'
# === End Xray Manager ===
ALIASES
    echo "✅ 快捷命令和代理变量已添加"
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
echo "  xray-ui       启动 Web 管理界面"
echo "  xray-restart   重启 xray"
echo "  xray-status    查看状态"
echo "  xray-log       查看日志"
echo "  xray-config    编辑配置"
echo ""
echo "代理端口："
echo "  SOCKS 代理:  127.0.0.1:10808"
echo "  HTTP 代理:   127.0.0.1:20171"
echo "  Web 管理 UI: http://127.0.0.1:8888"
echo ""
echo "环境变量已设置 http_proxy/https_proxy 指向 HTTP 代理 (20171)"
echo "CLI 工具 (claude, npm, curl 等) 将自动使用此代理"
echo ""
echo "⚠️  系统全局代理请在: 系统设置 → 网络 → Wi-Fi → 代理 → SOCKS 代理 → 127.0.0.1:10808"
echo ""
