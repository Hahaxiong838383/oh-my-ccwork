#!/usr/bin/env bash
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
TASK_JDK=${TASK_JDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/jdk-21}
TASK_SDK=${TASK_SDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk}
umask 077
mkdir -p "$TASK_DIR/build"
TASK_TEST_DIR=$(mktemp -d "$TASK_DIR/build/isolated-test.XXXXXX")
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
    "$TASK_JDK/bin/keytool" -genkeypair -alias "$TASK_ALIAS" -keyalg RSA -keysize 2048 -validity 1 -dname "CN=$TASK_CN" -ext "SAN=dns:$TASK_CN" -keystore "$TASK_TEST_DIR/$TASK_ALIAS.p12" -storepass:file "$TASK_TEST_DIR/password" -keypass:file "$TASK_TEST_DIR/password" >/dev/null 2>&1
    "$TASK_JDK/bin/keytool" -exportcert -alias "$TASK_ALIAS" -keystore "$TASK_TEST_DIR/$TASK_ALIAS.p12" -storepass:file "$TASK_TEST_DIR/password" -file "$TASK_TEST_DIR/$TASK_ALIAS.cer" >/dev/null 2>&1
    "$TASK_JDK/bin/keytool" -importcert -noprompt -alias "$TASK_ALIAS" -keystore "$TASK_TEST_DIR/trust.p12" -storepass:file "$TASK_TEST_DIR/password" -file "$TASK_TEST_DIR/$TASK_ALIAS.cer" >/dev/null 2>&1
  fi
done
"$TASK_JDK/bin/javac" --release 8 -cp "$TASK_DIR/build/classes:$TASK_SDK/platforms/android-34/android.jar" -d "$TASK_TEST_DIR" "$TASK_DIR/WatchdogSelfTest.java"
"$TASK_JDK/bin/java" -cp "$TASK_TEST_DIR:$TASK_DIR/build/classes:$TASK_SDK/platforms/android-34/android.jar" WatchdogSelfTest "$TASK_TEST_DIR"
