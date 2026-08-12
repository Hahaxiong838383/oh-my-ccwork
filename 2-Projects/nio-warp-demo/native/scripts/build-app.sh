#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$NATIVE_DIR/dist/NIOWarpApp.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

cd "$NATIVE_DIR"
swift build -c release

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
cp "$NATIVE_DIR/.build/release/NIOWarpApp" "$MACOS_DIR/NIOWarpApp"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>NIO Warp</string>
  <key>CFBundleExecutable</key>
  <string>NIOWarpApp</string>
  <key>CFBundleIdentifier</key>
  <string>com.mycc.nio-warp-demo</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>NIOWarpApp</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - \
  --requirements '=designated => identifier "com.mycc.nio-warp-demo"' \
  "$APP_DIR"
echo "$APP_DIR"
