#!/usr/bin/env bash
# 小可 Night · 可复现构建脚本（离线，只用本机 toolchain）
#
#   bash scripts/build.sh [--release]
#
# 输入：
#   ./assets/                前端（index.html / session.js，以及你自己加的静态资源）
#   ./vendor/livekit-client-2.15.6.umd.js   锁版 SDK 兜底副本（离线，不联网）
#   ../web/personal/         若存在 node_modules/livekit-client，优先用它，并核对锁版号
#   ./src ./res ./AndroidManifest.xml
#
# 输出：
#   build/xiaoke-night-host-V1.0.13.apk   已签名、zipalign、非 debuggable
#   build/build-info.json                 产物指纹（含 SDK 来源、证书指纹，不含任何口令）
#
# 环境变量（全部可选）：
#   NIGHT_ANDROID_TOOLCHAIN  toolchain 根目录，默认 ~/.local/share/codeg-android-toolchain
#   NIGHT_ANDROID_SDK        SDK 根目录（默认 $TOOLCHAIN/android-sdk）
#   NIGHT_BUILD_TOOLS        build-tools 版本，默认 35.0.0
#   NIGHT_PLATFORM           android.jar 路径，默认 $SDK/platforms/android-36/android.jar
#   NIGHT_JAVA_HOME          JDK 根目录（默认 $TOOLCHAIN/jdk-21）
#   NIGHT_LIVEKIT_JS         直接指定 livekit UMD 文件
#   NIGHT_WEB_PERSONAL       web/personal 目录（默认 <项目>/../web/personal）
#   NIGHT_KEYS_DIR           本地私钥目录，默认 ~/work-private/xiaoke-night-signing-1126
#   NIGHT_KEYSTORE           外部 keystore（.jks/.p12），给了就不用本地私钥
#   NIGHT_KEYSTORE_PASS_FILE 外部 keystore 口令文件（600）；或 NIGHT_KEYSTORE_PASS
#   NIGHT_KEY_ALIAS          key 别名，默认 night-release
#   NIGHT_KEY_PASS_FILE      key 口令文件；缺省沿用 keystore 口令
#   NIGHT_KEY_PASS           key 口令（会落到一次性 600 临时文件）
#
# 口令只经环境变量/600 文件传给 apksigner（--ks-pass file:），不进命令行、不打印、不入 git。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

PKG="cc.hahaxiong.xiaoke.night"
VERSION_NAME="V1.0.13"
VERSION_CODE="1000013"
MIN_SDK="26"
TARGET_SDK="34"
LIVEKIT_LOCKED="2.15.6"

TOOLCHAIN="${NIGHT_ANDROID_TOOLCHAIN:-$HOME/.local/share/codeg-android-toolchain}"
SDK="${NIGHT_ANDROID_SDK:-$TOOLCHAIN/android-sdk}"
BT_VERSION="${NIGHT_BUILD_TOOLS:-35.0.0}"
BT="$SDK/build-tools/$BT_VERSION"
PLATFORM="${NIGHT_PLATFORM:-$SDK/platforms/android-36/android.jar}"
JAVA_HOME="${NIGHT_JAVA_HOME:-$TOOLCHAIN/jdk-21}"

OUT="$PROJECT_DIR/build"
APK_UNSIGNED="$OUT/apk-unsigned-raw.apk"
APK_DEXED="$OUT/apk-unsigned.apk"
APK_ALIGNED="$OUT/apk-aligned.apk"
APK_FINAL="$OUT/xiaoke-night-host-$VERSION_NAME.apk"

die() { printf '\n[build] FAIL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n[build] %s\n' "$*"; }

need_file() { [ -f "$1" ] || die "缺少文件: $1"; }
need_exec() { [ -x "$1" ] || die "缺少可执行文件: $1"; }

# ---------------------------------------------------------------- 工具链校验
step "校验 toolchain"
need_exec "$JAVA_HOME/bin/java"
need_exec "$JAVA_HOME/bin/javac"
need_exec "$JAVA_HOME/bin/keytool"
need_file "$PLATFORM"
for tool in aapt2 d8 zipalign apksigner; do need_exec "$BT/$tool"; done
command -v python3 >/dev/null || die "缺少 python3（用于把 classes.dex 写入 APK）"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
printf '  SDK       : %s\n' "$SDK"
printf '  build-tools: %s\n' "$BT_VERSION"
printf '  platform  : %s\n' "$PLATFORM"
printf '  java      : %s\n' "$("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

# -------------------------------------------------------------------- 清理
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/assets"

# ------------------------------------------- 前端资源（同级 assets/ 是唯一来源）
step "组装 assets"
[ -d "$PROJECT_DIR/assets" ] || die "缺少同级 assets/ 目录"
cp -R "$PROJECT_DIR/assets/." "$OUT/assets/"
need_file "$OUT/assets/index.html"

resolve_livekit() {
  if [ -n "${NIGHT_LIVEKIT_JS:-}" ]; then
    need_file "$NIGHT_LIVEKIT_JS"
    printf '%s' "$NIGHT_LIVEKIT_JS"
    return 0
  fi
  local web_personal="${NIGHT_WEB_PERSONAL:-$PROJECT_DIR/../web/personal}"
  local from_node="$web_personal/node_modules/livekit-client/dist/livekit-client.umd.js"
  if [ -f "$from_node" ]; then
    if [ -f "$web_personal/package.json" ]; then
      local locked
      locked="$(python3 - "$web_personal/package.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
print((d.get('dependencies') or {}).get('livekit-client',''))
PY
)"
      if [ -n "$locked" ] && [ "$locked" != "$LIVEKIT_LOCKED" ]; then
        die "web/personal 锁版是 $locked，但本脚本固定 $LIVEKIT_LOCKED；先对齐锁版再构建"
      fi
    fi
    printf '%s' "$from_node"
    return 0
  fi
  local vendored="$PROJECT_DIR/vendor/livekit-client-$LIVEKIT_LOCKED.umd.js"
  if [ -f "$vendored" ]; then
    ( cd "$PROJECT_DIR/vendor" && sha256sum -c --ignore-missing SHA256SUMS.txt >/dev/null ) \
      || die "vendor 里的 livekit UMD 校验失败（SHA256SUMS.txt）"
    printf '%s' "$vendored"
    return 0
  fi
  die "找不到 livekit-client $LIVEKIT_LOCKED UMD：装好 web/personal 依赖，或放 vendor/livekit-client-$LIVEKIT_LOCKED.umd.js（本脚本不联网下载）"
}

LIVEKIT_SRC="$(resolve_livekit)"
LIVEKIT_SHA="$(sha256sum "$LIVEKIT_SRC" | awk '{print $1}')"
cp "$LIVEKIT_SRC" "$OUT/assets/livekit.js"
cp "$PROJECT_DIR/../web/personal/node_modules/livekit-client/LICENSE" "$OUT/assets/LIVEKIT-LICENSE"
need_file "$OUT/assets/session.js"
printf '  livekit   : %s (sha256 %s…)\n' "${LIVEKIT_SRC#$PROJECT_DIR/}" "${LIVEKIT_SHA:0:16}"

# --------------------------------------------- 远程 JS 禁令（构建期强校验）
step "校验 assets 不引用远程脚本/样式"
python3 - "$OUT/assets" <<'PY'
import os, re, sys
root = sys.argv[1]
allowed_host = "appassets.androidplatform.net"
patterns = [
    re.compile(r"""<(?:script|link|img|iframe|source|audio|video)[^>]*?\b(?:src|href)\s*=\s*["'](https?://[^"']+)""", re.I),
    re.compile(r"""import\s*\(\s*["'](https?://[^"']+)""", re.I),
    re.compile(r"""new\s+(?:Worker|SharedWorker)\s*\(\s*["'](https?://[^"']+)""", re.I),
    re.compile(r"""fetch\s*\(\s*["'](https?://[^"']+)""", re.I),
    re.compile(r"""XMLHttpRequest[\s\S]{0,200}?open\s*\(\s*["'][A-Z]+["']\s*,\s*["'](https?://[^"']+)""", re.I),
]
bad = []
for dirpath, _dirs, files in os.walk(root):
    for name in files:
        if not name.lower().endswith((".html", ".htm", ".js", ".mjs", ".css")):
            continue
        path = os.path.join(dirpath, name)
        if name == "livekit.js":
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        for pat in patterns:
            for m in pat.finditer(text):
                host = re.sub(r"^https?://", "", m.group(1)).split("/")[0]
                if host != allowed_host:
                    bad.append("%s -> %s" % (os.path.relpath(path, root), m.group(1)))
if bad:
    print("[build] FAIL: assets 里存在远程资源引用（禁止依赖网络远程 JS）:", file=sys.stderr)
    for line in sorted(set(bad)):
        print("  " + line, file=sys.stderr)
    sys.exit(1)
print("  ok: assets 内无远程脚本/样式引用")
PY

# ------------------------------------------------------------------ 资源编译
step "aapt2 compile"
"$BT/aapt2" compile --dir "$PROJECT_DIR/res" -o "$OUT/res.zip"

step "aapt2 link"
"$BT/aapt2" link \
  -o "$APK_UNSIGNED" \
  -I "$PLATFORM" \
  --manifest "$PROJECT_DIR/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  -A "$OUT/assets" \
  "$OUT/res.zip"

# ------------------------------------------------------------------- Java 编译
step "javac"
mapfile -t JAVA_SOURCES < <(find "$PROJECT_DIR/src" -name '*.java' | sort)
[ "${#JAVA_SOURCES[@]}" -gt 0 ] || die "src/ 下没有 Java 源文件"
PKG_PATH="${PKG//./\/}"
"$JAVA_HOME/bin/javac" \
  --release 8 \
  -classpath "$PLATFORM" \
  -encoding UTF-8 \
  -Xlint:-options \
  -d "$OUT/classes" \
  "${JAVA_SOURCES[@]}" \
  "$OUT/gen/$PKG_PATH/R.java"

step "d8"
mapfile -t CLASS_FILES < <(find "$OUT/classes" -name '*.class' | sort)
"$BT/d8" \
  --release \
  --min-api "$MIN_SDK" \
  --lib "$PLATFORM" \
  --output "$OUT/dex" \
  "${CLASS_FILES[@]}"
need_file "$OUT/dex/classes.dex"

step "写入 classes.dex"
python3 - "$APK_UNSIGNED" "$OUT/dex/classes.dex" "$APK_DEXED" <<'PY'
import shutil, sys, zipfile
src, dex, dst = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(src) as zin:
    names = zin.namelist()
    if "classes.dex" in names:
        sys.exit("[build] FAIL: aapt2 产物已含 classes.dex，流程异常")
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            zout.writestr(info, zin.read(info.filename))
        with open(dex, "rb") as fh:
            data = fh.read()
        zi = zipfile.ZipInfo("classes.dex", date_time=(2026, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        zout.writestr(zi, data)
print("  ok: classes.dex (%d bytes) 已写入" % len(data))
PY

step "zipalign"
"$BT/zipalign" -f -p 4 "$APK_DEXED" "$APK_ALIGNED"

# ---------------------------------------------------------------------- 签名
TMP_SECRET_DIR=""
cleanup() {
  if [ -n "$TMP_SECRET_DIR" ]; then rm -rf "$TMP_SECRET_DIR"; fi
}
trap cleanup EXIT

KEYS_DIR="${NIGHT_KEYS_DIR:-$HOME/work-private/xiaoke-night-signing-1126}"
KEY_ALIAS="${NIGHT_KEY_ALIAS:-night-release}"
CREATED_KEYSTORE=0

if [ -n "${NIGHT_KEYSTORE:-}" ]; then
  step "签名（外部 keystore）"
  KEYSTORE="$NIGHT_KEYSTORE"
  need_file "$KEYSTORE"
  KS_PASS_FILE="${NIGHT_KEYSTORE_PASS_FILE:-}"
  KEY_PASS_FILE="${NIGHT_KEY_PASS_FILE:-}"
else
  step "签名（本地私钥目录 $KEYS_DIR）"
  mkdir -p "$KEYS_DIR"
  chmod 700 "$KEYS_DIR"
  KEYSTORE="$KEYS_DIR/night-release.p12"
  KS_PASS_FILE="$KEYS_DIR/keystore.pass"
  KEY_PASS_FILE="$KS_PASS_FILE"
  if [ -f "$KEYSTORE" ]; then
    if [ ! -f "$KS_PASS_FILE" ]; then
      die "$KEYS_DIR 里已有 keystore 但缺少 keystore.pass，口令需人工恢复后再构建"
    fi
  else
    if [ -f "$KS_PASS_FILE" ]; then
      die "$KEYS_DIR 里有 keystore.pass 但 keystore 不见了，状态不一致，人工确认后再构建"
    fi
    GEN_PASS="$(openssl rand -hex 24)"
    NIGHT_GEN_PASS="$GEN_PASS" "$JAVA_HOME/bin/keytool" -genkeypair \
      -keystore "$KEYSTORE" \
      -storetype PKCS12 \
      -alias "$KEY_ALIAS" \
      -keyalg RSA -keysize 4096 -validity 12000 \
      -dname "CN=Xiaoke Night Host, OU=Personal, O=hahaxiong, C=CN" \
      -storepass:env NIGHT_GEN_PASS \
      -keypass:env NIGHT_GEN_PASS \
      >/dev/null 2>&1 || die "keytool 生成 keystore 失败"
    umask 077
    printf '%s\n' "$GEN_PASS" > "$KS_PASS_FILE"
    printf '%s' "$KEY_ALIAS" > "$KEYS_DIR/keystore.alias"
    chmod 600 "$KS_PASS_FILE" "$KEYSTORE" "$KEYS_DIR/keystore.alias"
    unset GEN_PASS
    CREATED_KEYSTORE=2
    printf '  已生成新的个人签名 keystore（请自行备份 %s）\n' "$KEYSTORE"
  fi
fi

need_file "$KEYSTORE"

if [ -z "${KS_PASS_FILE:-}" ] && [ -n "${NIGHT_KEYSTORE_PASS:-}" ]; then
  TMP_SECRET_DIR="$(mktemp -d)"; chmod 700 "$TMP_SECRET_DIR"
  KS_PASS_FILE="$TMP_SECRET_DIR/ks.pass"; umask 077; printf '%s\n' "$NIGHT_KEYSTORE_PASS" > "$KS_PASS_FILE"
fi
if [ -z "${KEY_PASS_FILE:-}" ] && [ -n "${NIGHT_KEY_PASS:-}" ]; then
  [ -n "$TMP_SECRET_DIR" ] || { TMP_SECRET_DIR="$(mktemp -d)"; chmod 700 "$TMP_SECRET_DIR"; }
  KEY_PASS_FILE="$TMP_SECRET_DIR/key.pass"; umask 077; printf '%s\n' "$NIGHT_KEY_PASS" > "$KEY_PASS_FILE"
fi
[ -n "${KS_PASS_FILE:-}" ] || die "缺少 keystore 口令：设置 NIGHT_KEYSTORE_PASS_FILE（或 NIGHT_KEYSTORE_PASS）"
[ -n "${KEY_PASS_FILE:-}" ] || KEY_PASS_FILE="$KS_PASS_FILE"
need_file "$KS_PASS_FILE"
need_file "$KEY_PASS_FILE"

# apksigner 的 file: 口令只能消费一次；store 与 key 同口令时不要重复传 --key-pass
SIGN_ARGS=(
  --ks "$KEYSTORE"
  --ks-key-alias "$KEY_ALIAS"
  --ks-pass "file:$KS_PASS_FILE"
  --v1-signing-enabled false
  --v2-signing-enabled true
  --v3-signing-enabled true
  --min-sdk-version "$MIN_SDK"
  --out "$APK_FINAL"
)
if [ "$KEY_PASS_FILE" != "$KS_PASS_FILE" ]; then
  SIGN_ARGS+=(--key-pass "file:$KEY_PASS_FILE")
fi

"$BT/apksigner" sign "${SIGN_ARGS[@]}" "$APK_ALIGNED"

step "apksigner verify"
"$BT/apksigner" verify --verbose --min-sdk-version "$MIN_SDK" "$APK_FINAL" \
  | sed -e 's/^/  /'

CERT_SHA="$("$BT/apksigner" verify --print-certs "$APK_FINAL" | grep -m1 'SHA-256 digest' | sed 's/.*: //')"
APK_SHA="$(sha256sum "$APK_FINAL" | awk '{print $1}')"
APK_SIZE="$(stat -c %s "$APK_FINAL")"

# ------------------------------------------------------------- 产物指纹记录
python3 - "$OUT/build-info.json" <<PY
import json, os, sys
info = {
    "package": "$PKG",
    "versionName": "$VERSION_NAME",
    "versionCode": int("$VERSION_CODE"),
    "minSdk": int("$MIN_SDK"),
    "targetSdk": int("$TARGET_SDK"),
    "debuggable": False,
    "apk": os.path.basename("$APK_FINAL"),
    "apkSha256": "$APK_SHA",
    "apkBytes": int("$APK_SIZE"),
    "signerCertSha256": "$CERT_SHA",
    "keystorePath": "$KEYSTORE",
    "keyAlias": "$KEY_ALIAS",
    "livekitSource": os.path.relpath("$LIVEKIT_SRC", "$PROJECT_DIR") if "$LIVEKIT_SRC".startswith("$PROJECT_DIR") else "$LIVEKIT_SRC",
    "livekitVersion": "$LIVEKIT_LOCKED",
    "livekitSha256": "$LIVEKIT_SHA",
    "keystoreCreatedThisRun": int("$CREATED_KEYSTORE"),
}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(info, indent=2, ensure_ascii=False) + "\n")
PY

step "完成"
printf '  apk    : %s\n' "$APK_FINAL"
printf '  size   : %s bytes\n' "$APK_SIZE"
printf '  sha256 : %s\n' "$APK_SHA"
printf '  证书   : %s\n' "${CERT_SHA:-unknown}"
printf '  指纹   : %s\n' "$OUT/build-info.json"
if [ "$CREATED_KEYSTORE" = "2" ]; then
  printf '\n  ! 本次新生成了签名 key：%s\n' "$KEYSTORE"
  printf '  ! 之后每次首发/升级必须用同一把 key，请立刻备份到自己的私密位置。\n'
fi
