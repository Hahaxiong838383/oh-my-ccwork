#!/usr/bin/env bash
# install-devtools.sh — 用户级安装/升级微信开发者工具（Linux 移植版）
#
# 为什么用 dpkg-deb -x 而不是 apt install：
#   本机 sudo 需要密码，agent 不能静默提权；deb 里的启动脚本全部用相对路径解析，
#   解包到用户目录即可运行，且升级/回滚只是换目录，不碰系统。
#
# 用法:
#   ./scripts/install-devtools.sh                 # 用 downloads/ 里最新的 deb
#   ./scripts/install-devtools.sh path/to/x.deb
#   ./scripts/install-devtools.sh --rollback      # 回滚到上一个版本
set -euo pipefail

MP_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$MP_ENV/app"
BACKUP_DIR="$MP_ENV/app.bak"
DL_DIR="$MP_ENV/downloads"

log() { printf '[install] %s\n' "$*"; }

if [[ "${1:-}" == "--rollback" ]]; then
  [[ -d "$BACKUP_DIR" ]] || { echo "[x] 没有可回滚的备份（$BACKUP_DIR）"; exit 2; }
  [[ -d "$APP_DIR" ]] && mv "$APP_DIR" "$MP_ENV/app.failed.$(date +%s)"
  mv "$BACKUP_DIR" "$APP_DIR"
  log "已回滚到上一版本"
  exit 0
fi

DEB="${1:-}"
if [[ -z "$DEB" ]]; then
  DEB="$(ls -1t "$DL_DIR"/*.deb 2>/dev/null | head -1 || true)"
fi
[[ -n "$DEB" && -f "$DEB" ]] || { echo "[x] 找不到 deb：请先下载到 $DL_DIR/"; exit 2; }

log "包：$DEB"
log "版本：$(dpkg-deb -f "$DEB" Version 2>/dev/null || echo unknown)"

if [[ -d "$APP_DIR" ]]; then
  rm -rf "$BACKUP_DIR"
  mv "$APP_DIR" "$BACKUP_DIR"
  log "旧版本已备份到 app.bak"
fi

mkdir -p "$APP_DIR"
dpkg-deb -x "$DEB" "$APP_DIR"
log "解包完成：$APP_DIR"

ROOT="$APP_DIR/opt/apps/io.github.msojocs.wechat-devtools-linux/files/bin"
[[ -x "$ROOT/electron/electron" ]] || { echo "[x] 解包后找不到 electron，包结构可能变了"; exit 1; }

chmod +x "$ROOT/bin/"* "$ROOT/electron/electron" 2>/dev/null || true

# 冒烟：库依赖是否齐全
MISSING="$(ldd "$ROOT/electron/electron" 2>/dev/null | grep -c 'not found' || true)"
if [[ "$MISSING" != "0" ]]; then
  echo "[!] 有 $MISSING 个共享库缺失："
  ldd "$ROOT/electron/electron" | grep 'not found'
  echo "    需要安装对应系统库（apt install）"
  exit 1
fi

log "依赖完整（0 缺失）"
log "下一步："
log "  GUI（需图形会话）: $MP_ENV/bin/wxdt"
log "  CLI:              $MP_ENV/bin/wxdt-cli islogin"
log "  自检:             $MP_ENV/bin/wxdt-doctor"
