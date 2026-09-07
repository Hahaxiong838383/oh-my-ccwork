#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_APP="$NATIVE_DIR/.build/app/NIOWarpApp.app"
INSTALL_DIR="$HOME/Applications"
INSTALL_APP="$INSTALL_DIR/NIOWarpApp.app"

if [[ "${1:-}" != "--skip-build" ]]; then
  "$SCRIPT_DIR/build-app.sh"
fi
codesign --verify --deep --strict "$SOURCE_APP"
if pgrep -x NIOWarpApp >/dev/null; then
  echo "请先退出正在运行的 NIO Warp，再安装更新；不会强制终止或覆盖运行中的应用。" >&2
  exit 1
fi
mkdir -p "$INSTALL_DIR"
BACKUP_DIR="$NATIVE_DIR/../.rollback/app-installs"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
INSTALL_STAGE="$(mktemp -d "$INSTALL_DIR/.nio-warp-install.XXXXXX")"
function finish_install {
  if [[ ! -d "$INSTALL_APP" && -d "$INSTALL_STAGE/previous.app" ]]; then
    mv "$INSTALL_STAGE/previous.app" "$INSTALL_APP"
  fi
  rm -rf "$INSTALL_STAGE"
}
trap finish_install EXIT
ditto "$SOURCE_APP" "$INSTALL_STAGE/NIOWarpApp.app"
codesign --verify --deep --strict "$INSTALL_STAGE/NIOWarpApp.app"

if [[ -d "$INSTALL_APP" ]]; then
  BACKUP_APP="$BACKUP_DIR/NIOWarpApp-before-$(date +%Y%m%d-%H%M%S).zip"
  ditto -c -k --keepParent "$INSTALL_APP" "$BACKUP_APP"
  unzip -t "$BACKUP_APP" >/dev/null
  mv "$INSTALL_APP" "$INSTALL_STAGE/previous.app"
  echo "Previous installation archived without a duplicate App icon: $BACKUP_APP"
fi

mv "$INSTALL_STAGE/NIOWarpApp.app" "$INSTALL_APP"
codesign --verify --deep --strict "$INSTALL_APP"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREGISTER" -f "$INSTALL_APP"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALL_APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INSTALL_APP/Contents/Info.plist")"
echo "Installed NIO Warp v$VERSION ($BUILD): $INSTALL_APP"
