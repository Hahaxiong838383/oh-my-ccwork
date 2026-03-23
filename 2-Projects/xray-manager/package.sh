#!/bin/bash
# Xray Manager 离线打包脚本
# 用法: ./package.sh [macos|windows|both]
# 产出: xray-manager-{os}-{arch}.tar.gz

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="1.3"
BUILD_DIR="/tmp/xray-manager-build"

# 颜色
GREEN='\033[0;32m'
NC='\033[0m'

log() { echo -e "${GREEN}[PACK]${NC} $1"; }

package_macos() {
    local ARCH="${1:-arm64}"  # arm64 or amd64
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

    # 核心文件
    cp "$SCRIPT_DIR/xray-manager.py" "$PKG_DIR/"
    cp "$SCRIPT_DIR/install.sh" "$PKG_DIR/"
    cp "$SCRIPT_DIR/service/com.xray.proxy.plist" "$PKG_DIR/service/"
    cp "$SCRIPT_DIR/README.md" "$PKG_DIR/"
    chmod +x "$PKG_DIR/install.sh"

    # 空配置模板（不含敏感信息）
    cat > "$PKG_DIR/config/config.json.example" << 'TMPL'
{
  "log": {"loglevel": "warning"},
  "inbounds": [{"tag": "socks", "port": 10808, "listen": "127.0.0.1", "protocol": "mixed", "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}, "settings": {"auth": "noauth", "udp": true}}],
  "outbounds": [{"tag": "direct", "protocol": "freedom"}, {"tag": "block", "protocol": "blackhole"}],
  "routing": {"domainStrategy": "AsIs", "rules": [{"type": "field", "outboundTag": "direct", "ip": ["geoip:cn"]}, {"type": "field", "outboundTag": "direct", "domain": ["geosite:cn"]}]}
}
TMPL

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

    # geo 文件
    for f in geoip.dat geosite.dat; do
        if [ -f "$HOME/xray/$f" ]; then
            cp "$HOME/xray/$f" "$PKG_DIR/$f"
        elif [ -f "$HOME/Library/Application Support/v2rayN/bin/$f" ]; then
            cp "$HOME/Library/Application Support/v2rayN/bin/$f" "$PKG_DIR/$f"
        else
            log "  下载 $f ..."
            if [ "$f" = "geoip.dat" ]; then
                curl -sL "https://github.com/v2fly/geoip/releases/latest/download/geoip.dat" -o "$PKG_DIR/$f"
            else
                curl -sL "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat" -o "$PKG_DIR/$f"
            fi
        fi
    done

    # 打包
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

    # 核心文件
    cp "$SCRIPT_DIR/xray-manager.py" "$PKG_DIR/"
    cp "$SCRIPT_DIR/install.bat" "$PKG_DIR/"
    cp "$SCRIPT_DIR/README.md" "$PKG_DIR/"

    # 空配置模板
    cat > "$PKG_DIR/config/config.json.example" << 'TMPL'
{
  "log": {"loglevel": "warning"},
  "inbounds": [{"tag": "socks", "port": 10808, "listen": "127.0.0.1", "protocol": "mixed", "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}, "settings": {"auth": "noauth", "udp": true}}],
  "outbounds": [{"tag": "direct", "protocol": "freedom"}, {"tag": "block", "protocol": "blackhole"}],
  "routing": {"domainStrategy": "AsIs", "rules": [{"type": "field", "outboundTag": "direct", "ip": ["geoip:cn"]}, {"type": "field", "outboundTag": "direct", "domain": ["geosite:cn"]}]}
}
TMPL

    # xray 二进制（从本地 V2RayN 或下载）
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

    # geo 文件
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

    # 打包 zip（Windows 友好）
    cd "$BUILD_DIR"
    if command -v zip &>/dev/null; then
        zip -qr "${PKG_NAME}.zip" "$PKG_NAME"
        log "✅ Windows 包: ${BUILD_DIR}/${PKG_NAME}.zip ($(du -sh "${PKG_NAME}.zip" | cut -f1))"
    else
        tar czf "${PKG_NAME}.tar.gz" "$PKG_NAME"
        log "✅ Windows 包: ${BUILD_DIR}/${PKG_NAME}.tar.gz ($(du -sh "${PKG_NAME}.tar.gz" | cut -f1))"
    fi
}

# 主入口
mkdir -p "$BUILD_DIR"

case "${1:-both}" in
    macos)  package_macos "${2:-arm64}" ;;
    windows) package_windows ;;
    both)
        package_macos arm64
        package_windows
        echo ""
        log "=== 打包完成 ==="
        ls -lh "$BUILD_DIR"/xray-manager-*
        ;;
    *)
        echo "用法: $0 [macos|windows|both] [arch]"
        exit 1
        ;;
esac
