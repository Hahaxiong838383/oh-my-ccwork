#!/usr/bin/env bash
set -euo pipefail
umask 077
D="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUT="${TV_STATUS_BUILD_DIR:-/tmp/tv-network-status-build}"
TC="${ANDROID_TOOLCHAIN:-/home/hahaxiong83/.local/share/codeg-android-toolchain}"
export JAVA_HOME="$TC/jdk-21"
export PATH="$JAVA_HOME/bin:$PATH"
BT="$TC/android-sdk/build-tools/34.0.0"
AJ="$TC/android-sdk/platforms/android-34/android.jar"
mkdir -p "$OUT/classes" "$OUT/generated" "$OUT/dex" "$OUT/tests"
javac --release 8 -d "$OUT/tests" "$D/src/cn/hahaxiong/tvnetstatus/StatusModel.java" "$D/test/StatusModelTest.java"
java -cp "$OUT/tests" cn.hahaxiong.tvnetstatus.StatusModelTest
python3 "$D/test/test_source.py"
for script in watch.sh state.sh 98-tv-network-status.sh; do sh -n "$D/$script"; done
"$BT/aapt2" link -I "$AJ" --manifest "$D/AndroidManifest.xml" --java "$OUT/generated" -o "$OUT/base.apk"
rg --files "$D/src" "$OUT/generated" -g '*.java' > "$OUT/sources.list"
javac --release 8 -parameters -classpath "$AJ" -d "$OUT/classes" @"$OUT/sources.list"
rg --files "$OUT/classes" -g '*.class' > "$OUT/classes.list"
"$BT/d8" --min-api 30 --lib "$AJ" --output "$OUT/dex" @"$OUT/classes.list"
python3 - "$OUT" <<'PY'
import pathlib,sys,shutil,zipfile
p=pathlib.Path(sys.argv[1]); shutil.copyfile(p/'base.apk',p/'unaligned.apk')
with zipfile.ZipFile(p/'unaligned.apk','a',zipfile.ZIP_DEFLATED) as z:
    for d in (p/'dex').glob('*.dex'): z.write(d,d.name)
PY
"$BT/zipalign" -f 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"
SIGN_TMP="$(mktemp -d "$OUT/sign.XXXXXXXX")"
trap 'rm -rf -- "$SIGN_TMP"' EXIT
python3 "$D/signing.py" "$SIGN_TMP"
"$BT/apksigner" sign --ks "$SIGN_TMP/signing.p12" --ks-key-alias tvnetstatus \
  --ks-pass "file:$SIGN_TMP/password" --out "$OUT/tv-network-status.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/tv-network-status.apk"
sha256sum "$OUT/tv-network-status.apk"
