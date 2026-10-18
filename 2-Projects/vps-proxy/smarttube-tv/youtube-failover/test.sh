#!/usr/bin/env bash
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
TASK_BUILD_DIR=${TASK_BUILD_DIR:-$TASK_DIR/build}
TASK_JDK=${TASK_JDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/jdk-21}
TASK_SDK=${TASK_SDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk}
umask 077
mkdir -p "$TASK_BUILD_DIR"
TASK_JSON_JAR=${TASK_JSON_JAR:-/home/hahaxiong83/home-lan/4-Assets/Code/netflix-cdn-watchdog/build/test-deps/json-20240303.jar}
cp "$TASK_JSON_JAR" "$TASK_BUILD_DIR/json.jar"
TASK_TEST_DIR=$(mktemp -d "$TASK_BUILD_DIR/isolated-test.XXXXXX")
trap 'rm -rf -- "$TASK_TEST_DIR"' EXIT
python3 - "$TASK_TEST_DIR/password" <<'PY'
import pathlib,secrets,sys
p=pathlib.Path(sys.argv[1])
if not p.exists():p.write_text(secrets.token_urlsafe(24))
PY
for TASK_ALIAS in matching wrong; do
  TASK_CN=speed.cloudflare.com
  if [[ "$TASK_ALIAS" == wrong ]]; then TASK_CN=wrong.invalid; fi
  if [[ ! -e "$TASK_TEST_DIR/$TASK_ALIAS.p12" ]]; then
    "$TASK_JDK/bin/keytool" -genkeypair -alias "$TASK_ALIAS" -keyalg RSA -keysize 2048 -validity 1 -dname "CN=$TASK_CN" -ext "SAN=dns:$TASK_CN,dns:www.youtube.com,dns:cloudflare-dns.com" -keystore "$TASK_TEST_DIR/$TASK_ALIAS.p12" -storepass:file "$TASK_TEST_DIR/password" -keypass:file "$TASK_TEST_DIR/password" >/dev/null 2>&1
    "$TASK_JDK/bin/keytool" -exportcert -alias "$TASK_ALIAS" -keystore "$TASK_TEST_DIR/$TASK_ALIAS.p12" -storepass:file "$TASK_TEST_DIR/password" -file "$TASK_TEST_DIR/$TASK_ALIAS.cer" >/dev/null 2>&1
    "$TASK_JDK/bin/keytool" -importcert -noprompt -alias "$TASK_ALIAS" -keystore "$TASK_TEST_DIR/trust.p12" -storepass:file "$TASK_TEST_DIR/password" -file "$TASK_TEST_DIR/$TASK_ALIAS.cer" >/dev/null 2>&1
  fi
done
"$TASK_JDK/bin/javac" --release 8 -Xlint:-options -cp "$TASK_BUILD_DIR/classes:$TASK_BUILD_DIR/json.jar:$TASK_SDK/platforms/android-34/android.jar" -d "$TASK_TEST_DIR" "$TASK_DIR/TransportTest.java" "$TASK_DIR/GuardTest.java"
"$TASK_JDK/bin/java" -cp "$TASK_TEST_DIR:$TASK_BUILD_DIR/classes:$TASK_BUILD_DIR/json.jar:$TASK_SDK/platforms/android-34/android.jar" TransportTest "$TASK_TEST_DIR"

"$TASK_JDK/bin/java" -cp "$TASK_TEST_DIR:$TASK_BUILD_DIR/classes:$TASK_BUILD_DIR/json.jar:$TASK_SDK/platforms/android-34/android.jar" GuardTest "$TASK_TEST_DIR" > "$TASK_BUILD_DIR/guard-test.log" 2>&1 || { tail -n 60 "$TASK_BUILD_DIR/guard-test.log"; exit 1; }
tail -n 1 "$TASK_BUILD_DIR/guard-test.log"
