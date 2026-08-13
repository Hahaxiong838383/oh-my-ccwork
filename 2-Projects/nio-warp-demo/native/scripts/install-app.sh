#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_APP="$NATIVE_DIR/.build/app/NIOWarpApp.app"
INSTALL_DIR="$HOME/Applications"
INSTALL_APP="$INSTALL_DIR/NIOWarpApp.app"

"$SCRIPT_DIR/build-app.sh"
mkdir -p "$INSTALL_DIR"

if [[ -d "$INSTALL_APP" ]]; then
  BACKUP_APP="/tmp/NIOWarpApp-before-install-$(date +%Y%m%d-%H%M%S).app"
  mv "$INSTALL_APP" "$BACKUP_APP"
  echo "Previous installation backed up to: $BACKUP_APP"
fi

ditto "$SOURCE_APP" "$INSTALL_APP"
codesign --verify --deep --strict "$INSTALL_APP"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREGISTER" -f "$INSTALL_APP"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALL_APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INSTALL_APP/Contents/Info.plist")"
echo "Installed NIO Warp v$VERSION ($BUILD): $INSTALL_APP"
