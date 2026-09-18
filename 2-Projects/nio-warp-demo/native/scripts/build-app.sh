#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$NATIVE_DIR/.build/app/NIOWarpApp.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
APP_VERSION="${NIO_WARP_APP_VERSION:-0.13.15}"
APP_BUILD="${NIO_WARP_APP_BUILD:-67}"

cd "$NATIVE_DIR"
swift build -c release
SOURCE_DIGEST="$( { find Sources -type f \( -name '*.swift' -o -name '*.m' -o -name '*.h' \) -print; printf '%s\n' Package.swift config/default-warp-configuration.json; } | LC_ALL=C sort | while IFS= read -r source; do shasum -a 256 "$source"; done | shasum -a 256 | awk '{print $1}')"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
cp "$NATIVE_DIR/.build/release/NIOWarpApp" "$MACOS_DIR/NIOWarpApp"

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
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
  <string>${APP_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${APP_BUILD}</string>
  <key>NIOWarpSourceSHA256</key>
  <string>${SOURCE_DIGEST}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

SIGNING_IDENTITY="${NIO_WARP_CODESIGN_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development:/{print $2; exit}')"
fi

if [[ -n "$SIGNING_IDENTITY" ]]; then
  codesign --force --deep --sign "$SIGNING_IDENTITY" "$APP_DIR"
  echo "Signed with stable identity: $SIGNING_IDENTITY"
else
  codesign --force --deep --sign - \
    --requirements '=designated => identifier "com.mycc.nio-warp-demo"' \
    "$APP_DIR"
  echo "Warning: no Apple Development identity found; Screen Recording permission may need renewal after rebuild." >&2
fi
echo "$APP_DIR"
