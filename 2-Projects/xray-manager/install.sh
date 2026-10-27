#!/bin/bash
# Xray Manager 一键安装脚本 (Linux / macOS 自适应)
set -e

# Managed cf-lisa deployments have reviewed runtime patches and strict config guards.
# Check before dirname/uname, downloads, file writes, service changes or cron setup.
if [ -e "$HOME/xray/company-lisa-failover/controller.json" ] || \
   [ -L "$HOME/xray/company-lisa-failover/controller.json" ] || \
   [ -e "$HOME/Library/LaunchAgents/com.company.lisa-failover.plist" ] || \
   [ -L "$HOME/Library/LaunchAgents/com.company.lisa-failover.plist" ]; then
    echo "检测到受管 cf-lisa 安装：停止通用安装，避免覆盖运行态补丁或重启代理。请按 maintenance-20261027/README.md 的增量维护说明处理。" >&2
    exit 78
fi

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

# 6. 准备系统服务文件（配置完成后由向导启动）
echo "⚙️  准备系统服务文件 ..."

if [ "$OS" = "Darwin" ]; then
    # macOS: launchd（只生成 plist，不注册，由配置向导完成后启动）
    PLIST_NAME="com.xray.proxy"
    PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
    launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
    sed -e "s|__XRAY_BIN__|$XRAY_BIN|g" \
        -e "s|__CONFIG_PATH__|$CONFIG_PATH|g" \
        -e "s|__XRAY_HOME__|$XRAY_HOME|g" \
        -e "s|__LOG_PATH__|$LOG_PATH|g" \
        "$SCRIPT_DIR/service/com.xray.proxy.plist" > "$PLIST_PATH"
    echo "✅ launchd 服务文件已生成（将在配置完成后启动）"
else
    # Linux: systemd user service（只生成 unit 文件，不启动）
    SERVICE_PATH="$HOME/.config/systemd/user/xray.service"
    sed -e "s|__XRAY_BIN__|$XRAY_BIN|g" \
        -e "s|__CONFIG_PATH__|$CONFIG_PATH|g" \
        -e "s|__XRAY_HOME__|$XRAY_HOME|g" \
        -e "s|__LOG_PATH__|$LOG_PATH|g" \
        "$SCRIPT_DIR/service/xray.service" > "$SERVICE_PATH"
    systemctl --user daemon-reload
    echo "✅ systemd 服务文件已生成（将在配置完成后启动）"
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
alias xray-update-subs='python3 ~/xray/xray-manager.py --update-subs'
alias xray-update-core='python3 ~/xray/xray-manager.py --update-core'
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
alias xray-update-subs='python3 ~/xray/xray-manager.py --update-subs'
alias xray-update-core='python3 ~/xray/xray-manager.py --update-core'
# === End Xray Manager ===
ALIASES
    fi
    echo "✅ 快捷命令已添加"
fi

# 8. 配置自动更新定时任务 (crontab)
echo "⏰ 配置自动更新定时任务 ..."
CRON_MARKER="# === Xray Auto Update ==="
if ! crontab -l 2>/dev/null | grep -q "$CRON_MARKER"; then
    (crontab -l 2>/dev/null; cat << CRON
$CRON_MARKER
# 每天凌晨 3 点自动更新订阅节点
0 3 * * * /usr/bin/python3 $XRAY_HOME/xray-manager.py --update-subs >> $XRAY_HOME/update.log 2>&1
# 每周一凌晨 4 点更新 xray 内核和 GeoIP
0 4 * * 1 /usr/bin/python3 $XRAY_HOME/xray-manager.py --update-core >> $XRAY_HOME/update.log 2>&1
# === End Xray Auto Update ===
CRON
    ) | crontab -
    echo "✅ 自动更新已注册: 订阅每天 03:00 / 内核每周一 04:00"
else
    echo "✅ 自动更新任务已存在"
fi

# 9. 启动配置向导
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

# 检测是否需要配置向导
HAS_NODES=0
if [ -f "$CONFIG_PATH" ]; then
    HAS_NODES=$(python3 -c "
import json
try:
    c=json.load(open('$CONFIG_PATH'))
    print(sum(1 for o in c.get('outbounds',[]) if o.get('protocol') in ('vless','vmess')))
except: print(0)
" 2>/dev/null)
fi

if [ "$HAS_NODES" = "0" ] || [ -z "$HAS_NODES" ]; then
    echo "🧙 首次安装，启动配置向导..."
    echo "   请在浏览器中完成节点和路由配置"
    echo "   配置完成后将自动启动代理服务并设置系统代理"
    echo ""
    python3 "$MANAGER_PATH"
else
    echo "✅ 检测到已有 $HAS_NODES 个节点配置"
    echo "   如需重新配置，运行: xray-ui"
    echo ""
    echo "Web 管理界面: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1'):8888"
    echo "SOCKS + HTTP 代理: 127.0.0.1:10808"
    echo ""
fi
