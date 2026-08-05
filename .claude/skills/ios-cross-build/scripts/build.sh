#!/bin/sh
# iOS 无 Xcode 交叉编译打包脚本（通用模板）
# 用法: sh build.sh <App名> <BundleID> <源码目录> [版本号] [图标.png]
# 源码目录: *.m 会被编译链接；其余文件(html/js/css/图片等)原样拷入 .app 根目录
set -e

APP_NAME="${1:?用法: sh build.sh <App名> <BundleID> <源码目录> [版本号] [图标]}" 2>/dev/null || {
  echo "用法: sh build.sh <App名> <BundleID> <源码目录> [版本号] [图标.png]"; exit 1; }
APP_NAME="$1"; BUNDLE_ID="$2"; SRC_DIR="$3"
VERSION="${4:-1.0.0}"; ICON="${5:-}"
SDK=/tmp/iPhoneOS16.5.sdk
BUILD=build
OUT_DIR=$(pwd)

# --- 环境检查 ---
command -v clang >/dev/null 2>&1 || { echo "❌ 缺 clang: apk add clang"; exit 1; }
command -v ld64.lld >/dev/null 2>&1 || { echo "❌ 缺 ld64.lld: apk add lld"; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "❌ 缺 zip: apk add zip"; exit 1; }
[ -d "$SDK" ] || { echo "❌ iOS SDK 不存在: $SDK（从 theos/sdks 下载 iPhoneOS16.5.sdk 解压到 /tmp）"; exit 1; }

echo "==> 1/4 编译源码"
rm -rf "$BUILD"; mkdir -p "$BUILD/app"
OBJS=""
for f in "$SRC_DIR"/*.m; do
  [ -f "$f" ] || continue
  o="$BUILD/$(basename "${f%.m}").o"
  clang --target=arm64-apple-ios16.5 -isysroot "$SDK" -fobjc-arc -I"$SRC_DIR" -c "$f" -o "$o"
  OBJS="$OBJS $o"
  echo "   ✓ $(basename "$f")"
done
[ -n "$OBJS" ] || { echo "❌ 源码目录没有 .m 文件: $SRC_DIR"; exit 1; }

echo "==> 2/4 链接 (ld64.lld)"
ld64.lld -arch arm64 -platform_version ios 16.5 0 -syslibroot "$SDK" \
  -framework Foundation -framework UIKit -framework WebKit \
  $OBJS -o "$BUILD/app/$APP_NAME"

echo "==> 3/4 组装 .app"
# Info.plist（UILaunchScreen 空字典必须有）
cat > "$BUILD/app/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>MinimumOSVersion</key><string>16.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>UILaunchScreen</key><dict/>
  <key>UISupportedInterfaceOrientations</key>
  <array><string>UIInterfaceOrientationPortrait</string></array>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict>
</plist>
PLIST
# 前端资源（非 .m/.h 文件原样拷入）
(cd "$SRC_DIR" && find . -type f ! -name '*.m' ! -name '*.h' -exec cp --parents {} "$OUT_DIR/$BUILD/app/" \;)
# 图标（可选）
if [ -n "$ICON" ] && [ -f "$ICON" ]; then
  mkdir -p "$BUILD/app/AppIcon.appiconset"
  cp "$ICON" "$BUILD/app/AppIcon.appiconset/AppIcon.png"
fi
mkdir -p "$BUILD/Payload"; mv "$BUILD/app" "$BUILD/Payload/$APP_NAME.app"

echo "==> 4/4 打包 IPA"
IPA="${APP_NAME}_v${VERSION}_未签名.ipa"
(cd "$BUILD" && zip -qry "../$IPA" Payload)
echo ""
echo "✅ 完成: $IPA  ($(du -h "$IPA" | cut -f1))"
echo "   安装: TrollStore 直接装 / AltStore / 自签（未签名需签名工具）"
