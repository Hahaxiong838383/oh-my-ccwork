#!/bin/bash
# sing-box 一键安装脚本（macOS / Linux）
# 安装到 ~/sing-box/，注册系统服务，添加 shell 快捷命令
set -e

# === 配置 ===
SB_HOME="$HOME/sing-box"
SB_VERSION="1.13.3"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.singbox.proxy"

# === 平台检测 ===
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

echo "=== sing-box 安装 ==="
echo "系统: $OS $ARCH"
echo "安装目录: $SB_HOME"
echo ""

# === 1. 创建目录 ===
mkdir -p "$SB_HOME"

# === 2. 安装二进制 ===
if [ -f "$SB_HOME/sing-box" ]; then
    echo "✓ sing-box 二进制已存在，跳过下载"
else
    if [ -f "$PROJECT_DIR/sing-box" ]; then
        echo "→ 从项目目录复制 sing-box 二进制..."
        cp "$PROJECT_DIR/sing-box" "$SB_HOME/sing-box"
    else
        echo "→ 下载 sing-box v${SB_VERSION}..."
        case "$OS" in
            Darwin) DL_OS="darwin" ;;
            Linux)  DL_OS="linux" ;;
            *)      echo "不支持的系统: $OS"; exit 1 ;;
        esac
        URL="https://github.com/SagerNet/sing-box/releases/download/v${SB_VERSION}/sing-box-${SB_VERSION}-${DL_OS}-${ARCH}.tar.gz"
        TMP="/tmp/sing-box-download.tar.gz"
        curl -L -o "$TMP" "$URL"
        tar xzf "$TMP" -C /tmp
        cp "/tmp/sing-box-${SB_VERSION}-${DL_OS}-${ARCH}/sing-box" "$SB_HOME/sing-box"
        rm -rf "$TMP" "/tmp/sing-box-${SB_VERSION}-${DL_OS}-${ARCH}"
    fi
    chmod +x "$SB_HOME/sing-box"
    echo "✓ sing-box 已安装"
fi
"$SB_HOME/sing-box" version | head -1

# === 3. 复制配置 ===
if [ -f "$SB_HOME/config.json" ]; then
    echo "✓ config.json 已存在，跳过（如需更新请手动替换）"
else
    if [ -f "$PROJECT_DIR/config.json" ]; then
        # 替换路径为实际安装路径
        sed "s|$PROJECT_DIR|$SB_HOME|g" "$PROJECT_DIR/config.json" > "$SB_HOME/config.json"
        echo "✓ config.json 已复制"
    else
        echo "⚠ 未找到 config.json，请手动创建"
    fi
fi

# === 4. 复制 rule-set 文件 ===
for f in geosite-cn.srs geoip-cn.srs; do
    if [ -f "$PROJECT_DIR/$f" ]; then
        cp "$PROJECT_DIR/$f" "$SB_HOME/$f"
        echo "✓ $f 已复制"
    fi
done

# === 5. 下载 Clash UI (Metacubexd) ===
if [ -d "$SB_HOME/ui" ]; then
    echo "✓ Web UI 已存在，跳过"
else
    echo "→ 下载 Metacubexd Web UI..."
    mkdir -p "$SB_HOME/ui"
    UI_URL="https://github.com/MetaCubeX/metacubexd/releases/latest/download/compressed-dist.tgz"
    if curl -L --max-time 30 -o /tmp/metacubexd.tgz "$UI_URL" 2>/dev/null; then
        tar xzf /tmp/metacubexd.tgz -C "$SB_HOME/ui" 2>/dev/null || true
        rm -f /tmp/metacubexd.tgz
        echo "✓ Web UI 已安装"
    else
        echo "⚠ Web UI 下载失败，可稍后手动安装"
    fi
fi

# === 6. 验证配置 ===
echo ""
echo "→ 验证配置..."
# 替换配置中的路径
if [ "$PROJECT_DIR" != "$SB_HOME" ]; then
    sed -i.bak "s|$PROJECT_DIR|$SB_HOME|g" "$SB_HOME/config.json" 2>/dev/null || \
    sed -i '' "s|$PROJECT_DIR|$SB_HOME|g" "$SB_HOME/config.json"
    rm -f "$SB_HOME/config.json.bak"
fi
cd "$SB_HOME" && ./sing-box check -c config.json
echo "✓ 配置验证通过"

# === 7. 注册系统服务 ===
echo ""
if [ "$OS" = "Darwin" ]; then
    # macOS launchd
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST_FILE="$PLIST_DIR/${PLIST_LABEL}.plist"
    mkdir -p "$PLIST_DIR"

    # 停止旧服务（如果有）
    launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true

    # 从模板生成 plist
    if [ -f "$PROJECT_DIR/service/com.singbox.proxy.plist" ]; then
        sed -e "s|__SB_BIN__|$SB_HOME/sing-box|g" \
            -e "s|__CONFIG_PATH__|$SB_HOME/config.json|g" \
            -e "s|__SB_HOME__|$SB_HOME|g" \
            -e "s|__LOG_PATH__|$SB_HOME/sing-box.log|g" \
            "$PROJECT_DIR/service/com.singbox.proxy.plist" > "$PLIST_FILE"
    else
        cat > "$PLIST_FILE" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${SB_HOME}/sing-box</string>
        <string>run</string>
        <string>-c</string>
        <string>${SB_HOME}/config.json</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SB_HOME}</string>
    <key>StandardOutPath</key>
    <string>${SB_HOME}/sing-box.log</string>
    <key>StandardErrorPath</key>
    <string>${SB_HOME}/sing-box.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
PLIST
    fi

    launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
    echo "✓ launchd 服务已注册（开机自启 + 崩溃自动重启）"

elif [ "$OS" = "Linux" ]; then
    # Linux systemd user service
    SERVICE_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SERVICE_DIR"
    cat > "$SERVICE_DIR/sing-box.service" << SVC
[Unit]
Description=sing-box proxy service
After=network.target

[Service]
Type=simple
ExecStart=${SB_HOME}/sing-box run -c ${SB_HOME}/config.json
WorkingDirectory=${SB_HOME}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SVC
    systemctl --user daemon-reload
    systemctl --user enable sing-box.service
    systemctl --user start sing-box.service
    echo "✓ systemd 服务已注册（开机自启）"
fi

# === 8. 添加 shell 快捷命令 ===
echo ""
if [ "$OS" = "Darwin" ]; then
    RCFILE="$HOME/.zshrc"
else
    RCFILE="$HOME/.bashrc"
fi

# 检查是否已添加
if grep -q "# === Sing-Box Manager ===" "$RCFILE" 2>/dev/null; then
    echo "✓ shell 快捷命令已存在，跳过"
else
    cat >> "$RCFILE" << 'SHELL'

# === Sing-Box Manager ===
alias sb-start='launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.singbox.proxy.plist 2>/dev/null || echo "已在运行"'
alias sb-stop='launchctl bootout gui/$(id -u)/com.singbox.proxy 2>/dev/null || echo "未在运行"'
alias sb-restart='sb-stop; sleep 1; sb-start; echo "sing-box 已重启"'
alias sb-status='ps aux | grep "[s]ing-box" && echo "---" && lsof -i :10809 | head -3 || echo "sing-box 未运行"'
alias sb-log='tail -50 ~/sing-box/sing-box.log'
alias sb-config='${EDITOR:-vim} ~/sing-box/config.json'
alias sb-ui='echo "打开 http://127.0.0.1:9090/ui" && open http://127.0.0.1:9090/ui 2>/dev/null'
alias sb-check='cd ~/sing-box && ./sing-box check -c config.json && echo "✓ 配置OK" && cd -'
# === End Sing-Box Manager ===
SHELL
    echo "✓ shell 快捷命令已添加到 $RCFILE"
fi

# === 9. 等待启动验证 ===
echo ""
echo "→ 等待 sing-box 启动..."
for i in $(seq 1 5); do
    sleep 1
    if lsof -i :10809 2>/dev/null | grep -q sing-box; then
        echo "✓ sing-box 已启动 (端口 10809)"
        break
    fi
    [ "$i" -eq 5 ] && echo "⚠ 启动较慢，请稍等后检查: sb-status"
done

# === 完成 ===
echo ""
echo "========================================="
echo "  sing-box 安装完成！"
echo "========================================="
echo ""
echo "  代理端口:  socks5://127.0.0.1:10809"
echo "             http://127.0.0.1:10809"
echo "  管理面板:  http://127.0.0.1:9090/ui"
echo ""
echo "  快捷命令:"
echo "    sb-start    启动服务"
echo "    sb-stop     停止服务"
echo "    sb-restart  重启服务"
echo "    sb-status   查看状态"
echo "    sb-log      查看日志"
echo "    sb-config   编辑配置"
echo "    sb-ui       打开管理面板"
echo "    sb-check    验证配置"
echo ""
echo "  请执行 source $RCFILE 或重开终端使快捷命令生效"
echo ""
