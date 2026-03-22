#!/bin/bash
# Xray Manager 离线打包脚本
# 用法: ./package.sh [macos|windows|linux|all]
# 产出: xray-manager-{os}-{arch}.tar.gz / .zip

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="2.0"
BUILD_DIR="/tmp/xray-manager-build"

# 颜色
GREEN='\033[0;32m'
NC='\033[0m'

log() { echo -e "${GREEN}[PACK]${NC} $1"; }

# 公共配置模板（含 HTTP inbound）
CONFIG_EXAMPLE='{
  "log": {"loglevel": "warning"},
  "inbounds": [
    {"tag": "socks", "port": 10808, "listen": "127.0.0.1", "protocol": "mixed", "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}, "settings": {"auth": "noauth", "udp": true}},
    {"tag": "http", "port": 20171, "listen": "127.0.0.1", "protocol": "http", "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}, "settings": {"timeout": 300, "allowTransparent": false}}
  ],
  "outbounds": [{"tag": "direct", "protocol": "freedom"}, {"tag": "block", "protocol": "blackhole"}],
  "routing": {"domainStrategy": "AsIs", "rules": [{"type": "field", "outboundTag": "direct", "ip": ["geoip:cn"]}, {"type": "field", "outboundTag": "direct", "domain": ["geosite:cn"]}]}
}'

# 下载 geo 文件的通用函数
copy_geo_files() {
    local PKG_DIR="$1"
    for f in geoip.dat geosite.dat; do
        local found=0
        for p in "$HOME/xray/$f" "$LOCALAPPDATA/v2rayN/bin/$f" "$HOME/Library/Application Support/v2rayN/bin/$f"; do
            if [ -f "$p" ]; then
                cp "$p" "$PKG_DIR/$f"
                found=1
                break
            fi
        done
        if [ $found -eq 0 ]; then
            log "  下载 $f ..."
            if [ "$f" = "geoip.dat" ]; then
                curl -sL "https://github.com/v2fly/geoip/releases/latest/download/geoip.dat" -o "$PKG_DIR/$f"
            else
                curl -sL "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat" -o "$PKG_DIR/$f"
            fi
        fi
    done
}

package_macos() {
    local ARCH="${1:-arm64}"
    local XRAY_ARCH
    if [ "$ARCH" = "arm64" ]; then
        XRAY_ARCH="darwin-arm64-v8a"
    else
        XRAY_ARCH="darwin-64"
    fi

    local PKG_NAME="xray-manager-macos-${ARCH}-v${VERSION}"
    local PKG_DIR="${BUILD_DIR}/${PKG_NAME}"

    log "打包 macOS ${ARCH} ..."
    rm -rf "$PKG_DIR"
    mkdir -p "$PKG_DIR/config" "$PKG_DIR/service"

    cp "$SCRIPT_DIR/xray-manager.py" "$PKG_DIR/"
    cp "$SCRIPT_DIR/install.sh" "$PKG_DIR/"
    cp "$SCRIPT_DIR/service/com.xray.proxy.plist" "$PKG_DIR/service/"
    cp "$SCRIPT_DIR/README.md" "$PKG_DIR/"
    chmod +x "$PKG_DIR/install.sh"
    echo "$CONFIG_EXAMPLE" > "$PKG_DIR/config/config.json.example"

    # xray 二进制
    local XRAY_LOCAL="$HOME/xray/xray"
    if [ -f "$XRAY_LOCAL" ]; then
        log "  使用本地 xray"
        cp "$XRAY_LOCAL" "$PKG_DIR/xray"
    else
        log "  下载 Xray-core ${XRAY_ARCH} ..."
        curl -sL "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-${XRAY_ARCH}.zip" -o /tmp/xray.zip
        unzip -qo /tmp/xray.zip -d /tmp/xray-dl
        cp /tmp/xray-dl/xray "$PKG_DIR/xray"
        rm -rf /tmp/xray.zip /tmp/xray-dl
    fi
    chmod +x "$PKG_DIR/xray"

    copy_geo_files "$PKG_DIR"

    cd "$BUILD_DIR"
    tar czf "${PKG_NAME}.tar.gz" "$PKG_NAME"
    log "✅ macOS 包: ${BUILD_DIR}/${PKG_NAME}.tar.gz ($(du -sh "${PKG_NAME}.tar.gz" | cut -f1))"
}

package_windows() {
    local PKG_NAME="xray-manager-windows-x64-v${VERSION}"
    local PKG_DIR="${BUILD_DIR}/${PKG_NAME}"

    log "打包 Windows x64 ..."
    rm -rf "$PKG_DIR"
    mkdir -p "$PKG_DIR/config"

    cp "$SCRIPT_DIR/xray-manager.py" "$PKG_DIR/"
    cp "$SCRIPT_DIR/install.bat" "$PKG_DIR/"
    cp "$SCRIPT_DIR/README.md" "$PKG_DIR/"
    echo "$CONFIG_EXAMPLE" > "$PKG_DIR/config/config.json.example"

    # xray 二进制
    local WIN_XRAY
    for p in "$LOCALAPPDATA/v2rayN/bin/xray/xray.exe" "$HOME/xray/xray.exe"; do
        if [ -f "$p" ]; then
            WIN_XRAY="$p"
            break
        fi
    done
    if [ -n "$WIN_XRAY" ]; then
        log "  使用本地 xray.exe"
        cp "$WIN_XRAY" "$PKG_DIR/xray.exe"
    else
        log "  下载 Xray-core windows-64 ..."
        curl -sL "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip" -o /tmp/xray-win.zip
        unzip -qo /tmp/xray-win.zip -d /tmp/xray-win-dl
        cp /tmp/xray-win-dl/xray.exe "$PKG_DIR/xray.exe"
        rm -rf /tmp/xray-win.zip /tmp/xray-win-dl
    fi

    copy_geo_files "$PKG_DIR"

    cd "$BUILD_DIR"
    if command -v zip &>/dev/null; then
        zip -qr "${PKG_NAME}.zip" "$PKG_NAME"
        log "✅ Windows 包: ${BUILD_DIR}/${PKG_NAME}.zip ($(du -sh "${PKG_NAME}.zip" | cut -f1))"
    else
        tar czf "${PKG_NAME}.tar.gz" "$PKG_NAME"
        log "✅ Windows 包: ${BUILD_DIR}/${PKG_NAME}.tar.gz ($(du -sh "${PKG_NAME}.tar.gz" | cut -f1))"
    fi
}

package_linux() {
    local ARCH="${1:-amd64}"
    local XRAY_ARCH
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
        XRAY_ARCH="linux-arm64-v8a"
        ARCH="arm64"
    else
        XRAY_ARCH="linux-64"
        ARCH="amd64"
    fi

    local PKG_NAME="xray-manager-linux-${ARCH}-v${VERSION}"
    local PKG_DIR="${BUILD_DIR}/${PKG_NAME}"

    log "打包 Linux ${ARCH} ..."
    rm -rf "$PKG_DIR"
    mkdir -p "$PKG_DIR/config" "$PKG_DIR/service"

    cp "$SCRIPT_DIR/xray-manager.py" "$PKG_DIR/"
    cp "$SCRIPT_DIR/install-linux.sh" "$PKG_DIR/install.sh"
    cp "$SCRIPT_DIR/service/xray-proxy.service" "$PKG_DIR/service/"
    cp "$SCRIPT_DIR/README.md" "$PKG_DIR/"
    chmod +x "$PKG_DIR/install.sh"
    echo "$CONFIG_EXAMPLE" > "$PKG_DIR/config/config.json.example"

    # xray 二进制
    local XRAY_LOCAL="$HOME/xray/xray"
    if [ -f "$XRAY_LOCAL" ] && file "$XRAY_LOCAL" | grep -q "ELF"; then
        log "  使用本地 xray"
        cp "$XRAY_LOCAL" "$PKG_DIR/xray"
    else
        log "  下载 Xray-core ${XRAY_ARCH} ..."
        curl -sL "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-${XRAY_ARCH}.zip" -o /tmp/xray-linux.zip
        unzip -qo /tmp/xray-linux.zip -d /tmp/xray-linux-dl
        cp /tmp/xray-linux-dl/xray "$PKG_DIR/xray"
        rm -rf /tmp/xray-linux.zip /tmp/xray-linux-dl
    fi
    chmod +x "$PKG_DIR/xray"

    copy_geo_files "$PKG_DIR"

    cd "$BUILD_DIR"
    tar czf "${PKG_NAME}.tar.gz" "$PKG_NAME"
    log "✅ Linux 包: ${BUILD_DIR}/${PKG_NAME}.tar.gz ($(du -sh "${PKG_NAME}.tar.gz" | cut -f1))"
}

# 主入口
mkdir -p "$BUILD_DIR"

case "${1:-all}" in
    macos)   package_macos "${2:-arm64}" ;;
    windows) package_windows ;;
    linux)   package_linux "${2:-amd64}" ;;
    all)
        package_macos arm64
        package_windows
        package_linux amd64
        echo ""
        log "=== 打包完成 ==="
        ls -lh "$BUILD_DIR"/xray-manager-*
        ;;
    *)
        echo "用法: $0 [macos|windows|linux|all] [arch]"
        echo "  macos   [arm64|amd64]   打包 macOS"
        echo "  windows                  打包 Windows x64"
        echo "  linux   [amd64|arm64]    打包 Linux"
        echo "  all                      打包所有平台"
        exit 1
        ;;
esac
