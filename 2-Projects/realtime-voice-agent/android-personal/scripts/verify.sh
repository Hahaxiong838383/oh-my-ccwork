#!/usr/bin/env bash
# 小可 Night · 产物独立校验（只读 APK，不参与构建、不做任何绕过）
#
#   bash scripts/verify.sh [apk 路径]
#
# 默认校验 build/xiaoke-night-host-V1.0.14.apk。
# 任一条断言不成立即非零退出。
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

APK="${1:-$PROJECT_DIR/build/xiaoke-night-host-V1.0.14.apk}"
TOOLCHAIN="${NIGHT_ANDROID_TOOLCHAIN:-$HOME/.local/share/codeg-android-toolchain}"
SDK="${NIGHT_ANDROID_SDK:-$TOOLCHAIN/android-sdk}"
BT="${SDK}/build-tools/${NIGHT_BUILD_TOOLS:-35.0.0}"
JAVA_HOME="${NIGHT_JAVA_HOME:-$TOOLCHAIN/jdk-21}"
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"

EXPECT_PKG="cc.hahaxiong.xiaoke.night"
EXPECT_VERSION_NAME="V1.0.14"
EXPECT_VERSION_CODE="1000014"
EXPECT_MIN_SDK="26"
EXPECT_TARGET_SDK="34"
EXPECT_ORIGIN="https://pa.hahaxiong.cc:8666/night-app/index.html"
EXPECT_ENDPOINT="https://pa.hahaxiong.cc:8666/api/voice/ticket"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*"; }
check() { # check <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then ok "$1 = $3"; else no "$1 期望 [$2] 实际 [$3]"; fi
}
has() { # has <描述> <haystack> <needle>
  case "$2" in *"$3"*) ok "$1" ;; *) no "$1（缺少 $3）" ;; esac
}
lacks() {
  case "$1" in *"$2"*) no "$3（不该出现 $2）" ;; *) ok "$3" ;; esac
}

[ -f "$APK" ] || { printf '[verify] 找不到 APK: %s\n' "$APK" >&2; exit 2; }
printf '[verify] %s\n' "$APK"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

BADGING="$("$BT/aapt2" dump badging "$APK" 2>/dev/null)"
MANIFEST="$("$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null)"
[ -n "$BADGING" ] || { printf '[verify] aapt2 无法解析 APK\n' >&2; exit 2; }

printf '\n— 包身份\n'
PKG_LINE="$(printf '%s\n' "$BADGING" | grep -m1 '^package:')"
check "package" "$EXPECT_PKG" "$(printf '%s' "$PKG_LINE" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
check "versionName" "$EXPECT_VERSION_NAME" "$(printf '%s' "$PKG_LINE" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
check "versionCode" "$EXPECT_VERSION_CODE" "$(printf '%s' "$PKG_LINE" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
check "minSdk" "minSdkVersion:'$EXPECT_MIN_SDK'" "$(printf '%s\n' "$BADGING" | grep -m1 'minSdkVersion:')"
check "targetSdk" "targetSdkVersion:'$EXPECT_TARGET_SDK'" "$(printf '%s\n' "$BADGING" | grep -m1 "targetSdkVersion:")"
has "launchable-activity" "$BADGING" "launchable-activity: name='$EXPECT_PKG.NightHostActivity'"
lacks "$BADGING" "application-debuggable" "非 debuggable"
has "application-label" "$BADGING" "小可 · 暗夜剧场"
has "桌面入口使用自适应图标" "$BADGING" "icon='res/mipmap-anydpi-v33/ic_launcher.xml'"
for api in 26 33; do
  ICON_TREE="$("$BT/aapt2" dump xmltree --file "res/mipmap-anydpi-v$api/ic_launcher.xml" "$APK" 2>/dev/null)"
  has "Android API $api 自适应图层" "$ICON_TREE" "E: adaptive-icon"
done
has "系统主题图标图层" "$ICON_TREE" "E: monochrome"
if unzip -p "$APK" res/drawable-nodpi-v4/night_b2_art.webp | cmp -s - "$PROJECT_DIR/res/drawable-nodpi/night_b2_art.webp"; then
  ok "成品内 B2 图像与发布资源相同"
else
  no "成品 B2 图像不一致"
fi

printf '\n— 权限面（通话、后台诊断、系统更新安装）\n'
PERMS="$(printf '%s\n' "$BADGING" | grep "^uses-permission:" | sed "s/uses-permission: name='\([^']*\)'.*/\1/" | sort)"
EXPECT_PERMS="$(printf '%s\n' \
  android.permission.INTERNET \
  android.permission.POST_NOTIFICATIONS \
  android.permission.ACCESS_NETWORK_STATE \
  android.permission.RECEIVE_BOOT_COMPLETED \
  android.permission.REQUEST_INSTALL_PACKAGES \
  android.permission.MODIFY_AUDIO_SETTINGS \
  android.permission.RECORD_AUDIO | sort)"
check "uses-permission 集合" "$(printf '%s' "$EXPECT_PERMS" | tr '\n' ',')" "$(printf '%s' "$PERMS" | tr '\n' ',')"
has "麦克风运行时权限" "$PERMS" "android.permission.RECORD_AUDIO"
lacks "$PERMS" "android.permission.CAMERA" "无摄像头权限"
lacks "$PERMS" "android.permission.READ_" "无读取存储/联系人等权限"
lacks "$PERMS" "android.permission.SYSTEM_ALERT_WINDOW" "无悬浮窗权限"

printf '\n— Manifest 安全属性\n'
has "启动 Activity 声明" "$MANIFEST" '.NightHostActivity"'
has "Activity exported=true" "$MANIFEST" "exported(0x01010010)=true"
check "activity 数量" "1" "$(printf '%s\n' "$MANIFEST" | grep -c 'E: activity')"
check "service 数量" "2" "$(printf '%s\n' "$MANIFEST" | grep -c 'E: service')"
check "receiver 数量" "2" "$(printf '%s\n' "$MANIFEST" | grep -c 'E: receiver')"
check "provider 数量" "0" "$(printf '%s\n' "$MANIFEST" | grep -c 'E: provider')"
has "debuggable=false" "$MANIFEST" "debuggable(0x0101000f)=false"
lacks "$MANIFEST" "debuggable(0x0101000f)=true" "未开启 debuggable"
has "allowBackup=false" "$MANIFEST" "allowBackup(0x01010280)=false"
has "usesCleartextTraffic=false" "$MANIFEST" "usesCleartextTraffic(0x010104ec)=false"
has "launchMode=singleTask(2)" "$MANIFEST" "launchMode(0x0101001d)=2"
has "resizeableActivity=false" "$MANIFEST" "resizeableActivity(0x010104f6)=false"
if printf '%s' "$MANIFEST" | grep -q 'android.intent.action.VIEW\|android.intent.action.SEND'; then
  no "不应有外部数据入口（VIEW/SEND）"
else
  ok "无外部数据入口（无 VIEW/SEND filter）"
fi
THEME_STYLE="$(printf '%s\n' "$MANIFEST" | grep -m1 'android:theme(0x01010000)')"
if [ -n "$THEME_STYLE" ]; then ok "theme 已设置（$THEME_STYLE）"; else no "未设置 theme"; fi
RES_DUMP="$("$BT/aapt2" dump resources "$APK" 2>/dev/null)"
has "NightTheme 样式资源存在" "$RES_DUMP" "NightTheme"

printf '\n— 签名\n'
VERIFY="$("$BT/apksigner" verify --verbose --min-sdk-version "$EXPECT_MIN_SDK" "$APK" 2>&1)"
has "签名可用" "$VERIFY" "Verifies"
has "v2 方案" "$VERIFY" "Verified using v2 scheme (APK Signature Scheme v2): true"
has "v3 方案" "$VERIFY" "Verified using v3 scheme (APK Signature Scheme v3): true"
has "单签名者" "$VERIFY" "Number of signers: 1"
CERT_SHA="$("$BT/apksigner" verify --print-certs "$APK" 2>/dev/null | grep -m1 'SHA-256 digest' | sed 's/.*: //')"
if [ -n "$CERT_SHA" ]; then ok "证书 SHA-256 = $CERT_SHA"; else no "取不到证书指纹"; fi
if [ -f "$PROJECT_DIR/build/build-info.json" ]; then
  RECORDED="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['signerCertSha256'])" "$PROJECT_DIR/build/build-info.json" 2>/dev/null)"
  check "证书与 build-info.json 一致" "$RECORDED" "$CERT_SHA"
fi

printf '\n— 内容\n'
unzip -q -o "$APK" -d "$WORK/apk" || { no "APK 解压失败"; }
for f in classes.dex assets/index.html assets/appearance.js assets/avatars/open/engine.js assets/avatars/boop/engine.js assets/avatars/robot/engine.js assets/session.js assets/orb-reference.js assets/orb-input.js assets/orb-surface.js assets/orb-motion.js assets/GrokBot-LICENSE.txt assets/livekit.js resources.arsc AndroidManifest.xml; do
  if [ -f "$WORK/apk/$f" ]; then ok "包含 $f"; else no "缺少 $f"; fi
done
if [ -f "$WORK/apk/assets/livekit.js" ]; then
  LIVEKIT_SIZE="$(stat -c %s "$WORK/apk/assets/livekit.js")"
  if [ "$LIVEKIT_SIZE" -gt 300000 ]; then ok "livekit.js 已打包（$LIVEKIT_SIZE bytes）"; else no "livekit.js 体积异常（$LIVEKIT_SIZE）"; fi
  if grep -q "2\.15\.6" "$WORK/apk/assets/livekit.js"; then ok "livekit 版本串 2.15.6 存在"; else no "未见 2.15.6 版本串"; fi
fi

# assets 里不得有远程脚本/样式引用（构建期已查，这里对成品再查一次）
REMOTE="$(grep -RIlE '<script[^>]+src=["'"'"']https?://|@import +url\(["'"'"']?https?://' "$WORK/apk/assets" 2>/dev/null | grep -v '/livekit.js$' || true)"
if [ -z "$REMOTE" ]; then ok "assets 无远程 script/style"; else no "assets 存在远程引用: $REMOTE"; fi

printf '\n— 原生契约（dex 常量）\n'
DEX_STRINGS="$("$JAVA_HOME/bin/java" -version >/dev/null 2>&1; strings "$WORK/apk/classes.dex" 2>/dev/null || cat "$WORK/apk/classes.dex")"
has "NightHostActivity 在 dex" "$DEX_STRINGS" "NightHostActivity"
has "JS 接口名 NightHost" "$DEX_STRINGS" "NightHost"
for m in paired pair forget ticket setCall micPermission diagnostics syncDiagnostics checkUpdate installUpdate; do
  has "桥接方法 $m" "$DEX_STRINGS" "$m"
done
has "票据端点（固定宿主）" "$DEX_STRINGS" "$EXPECT_ENDPOINT"
has "本地 origin host" "$DEX_STRINGS" "$EXPECT_ORIGIN"
lacks "$DEX_STRINGS" "http://pa.hahaxiong.cc" "端点不是明文 http"
has "音频模式 MODE_IN_COMMUNICATION 常量引用" "$DEX_STRINGS" "AudioGuard"
have_keystore="$(printf '%s' "$DEX_STRINGS" | grep -c 'AndroidKeyStore')"
if [ "$have_keystore" -gt 0 ]; then ok "使用 AndroidKeyStore"; else no "未见 AndroidKeyStore"; fi

printf '\n— 结果\n'
printf '    APK      : %s\n' "$APK"
printf '    size     : %s bytes\n' "$(stat -c %s "$APK")"
printf '    sha256   : %s\n' "$(sha256sum "$APK" | awk '{print $1}')"
printf '    passed   : %d\n' "$PASS"
printf '    failed   : %d\n' "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf '    VERDICT  : FAIL\n'
  exit 1
fi
printf '    VERDICT  : PASS\n'
