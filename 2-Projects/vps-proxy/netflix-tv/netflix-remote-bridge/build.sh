#!/usr/bin/env bash
set -euo pipefail
umask 077
TASK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOLCHAIN="${ANDROID_TOOLCHAIN:-/home/hahaxiong83/.local/share/codeg-android-toolchain}"
export JAVA_HOME="$TOOLCHAIN/jdk-21"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="$TOOLCHAIN/android-sdk"
BUILD_TOOLS="$SDK/build-tools/34.0.0"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
cd "$TASK_DIR"
SIGN_DIR="${BRIDGE_SIGN_DIR:-$TASK_DIR/private-signing}"
if [[ ! -s "$SIGN_DIR/bridge.p12" ]]; then
    if [[ "${BRIDGE_CREATE_SIGNING:-0}" != 1 ]]; then
        printf 'Signing key missing: %s. Restore the deployed key; only a first install may use BRIDGE_CREATE_SIGNING=1.\n' "$SIGN_DIR/bridge.p12" >&2
        exit 2
    fi
    if [[ -e "$SIGN_DIR/bridge.p12" || -e "$SIGN_DIR/password" ]]; then
        printf 'Incomplete signing state; refusing to overwrite existing key/password files.\n' >&2
        exit 2
    fi
    mkdir -p "$SIGN_DIR"
    chmod 700 "$SIGN_DIR"
    python3 - "$SIGN_DIR/password" <<'PY'
from pathlib import Path
import secrets,os,sys
p=Path(sys.argv[1])
with p.open('x') as f: f.write(secrets.token_urlsafe(36)+'\n')
os.chmod(p,0o600)
PY
    keytool -genkeypair -keystore "$SIGN_DIR/bridge.p12" -storetype PKCS12 -alias bridge -keyalg RSA -keysize 3072 -validity 3650 -dname 'CN=Netflix Remote Bridge Local' -storepass:file "$SIGN_DIR/password" -keypass:file "$SIGN_DIR/password" >/dev/null 2>&1
fi
if [[ ! -s "$SIGN_DIR/password" ]]; then
    printf 'Signing password file missing; refusing to replace deployed credentials.\n' >&2
    exit 2
fi
chmod 700 "$SIGN_DIR"
chmod 600 "$SIGN_DIR/bridge.p12" "$SIGN_DIR/password"
mkdir -p out/classes out/dex out/test-classes
javac --release 8 -d out/test-classes src/cn/hahaxiong/netflixremote/NavCore.java src/cn/hahaxiong/netflixremote/PlayerPolicy.java src/cn/hahaxiong/netflixremote/KeyState.java src/cn/hahaxiong/netflixremote/CandidateTree.java src/cn/hahaxiong/netflixremote/NodePolicy.java src/cn/hahaxiong/netflixremote/SeekPolicy.java src/cn/hahaxiong/netflixremote/FeedPolicy.java src/cn/hahaxiong/netflixremote/FeedNavigator.java src/cn/hahaxiong/netflixremote/LocalFeedInput.java test/LocalFeedInputTest.java test/FeedPolicyTest.java test/SeekPolicyTest.java test/NavCoreTest.java test/PlayerPolicyTest.java test/KeyStateTest.java test/CandidateTreeTest.java
java -cp out/test-classes cn.hahaxiong.netflixremote.NavCoreTest
java -cp out/test-classes cn.hahaxiong.netflixremote.PlayerPolicyTest
java -cp out/test-classes cn.hahaxiong.netflixremote.KeyStateTest
java -cp out/test-classes cn.hahaxiong.netflixremote.CandidateTreeTest
java -cp out/test-classes cn.hahaxiong.netflixremote.SeekPolicyTest
java -cp out/test-classes cn.hahaxiong.netflixremote.FeedPolicyTest
java -cp out/test-classes cn.hahaxiong.netflixremote.LocalFeedInputTest
"$BUILD_TOOLS/aapt2" compile --dir res -o out/resources.zip
"$BUILD_TOOLS/aapt2" link -I "$ANDROID_JAR" --manifest AndroidManifest.xml --java out/generated -o out/base.apk out/resources.zip
find src out/generated -name '*.java' -print > out/sources.list
# JDK 21 otherwise emits an unnamed synthetic constructor parameter which D8 8.2 cannot parse.
javac --release 8 -parameters -classpath "$ANDROID_JAR" -d out/classes @out/sources.list
find out/classes -name '*.class' -print > out/classes.list
"$BUILD_TOOLS/d8" --min-api 30 --lib "$ANDROID_JAR" --output out/dex @out/classes.list
cp out/base.apk out/unaligned.apk
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
with ZipFile('out/unaligned.apk','a',ZIP_DEFLATED) as z:
 for f in Path('out/dex').glob('*.dex'): z.write(f,f.name)
PY
"$BUILD_TOOLS/zipalign" -f 4 out/unaligned.apk out/aligned.apk
"$BUILD_TOOLS/apksigner" sign --ks "$SIGN_DIR/bridge.p12" --ks-key-alias bridge --ks-pass "file:$SIGN_DIR/password" --out out/netflix-remote-bridge.apk out/aligned.apk
"$BUILD_TOOLS/apksigner" verify --verbose out/netflix-remote-bridge.apk
sha256sum out/netflix-remote-bridge.apk
