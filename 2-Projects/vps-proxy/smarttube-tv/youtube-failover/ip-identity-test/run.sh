#!/bin/bash
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
TASK_PARENT=$(dirname "$TASK_DIR")
TASK_JDK=/home/hahaxiong83/.local/share/codeg-android-toolchain/jdk-21
TASK_SDK=/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk
umask 077
TASK_WORK=$(mktemp -d "$TASK_DIR/run.XXXXXX")
trap 'rm -rf "$TASK_WORK"' EXIT
python3 - "$TASK_WORK/password" <<'PY'
import secrets,sys,pathlib
pathlib.Path(sys.argv[1]).write_text(secrets.token_urlsafe(24))
PY
for TASK_KIND in correct wrong domain; do
 case "$TASK_KIND" in
  correct) TASK_SAN=ip:1.1.1.1;;
  wrong) TASK_SAN=ip:1.0.0.1;;
  domain) TASK_SAN=dns:cloudflare-dns.com;;
 esac
 "$TASK_JDK/bin/keytool" -genkeypair -alias "$TASK_KIND" -keyalg RSA -keysize 2048 -validity 1 -dname CN=fixture.invalid -ext "SAN=$TASK_SAN" -keystore "$TASK_WORK/$TASK_KIND.p12" -storepass:file "$TASK_WORK/password" -keypass:file "$TASK_WORK/password" >/dev/null 2>&1
 "$TASK_JDK/bin/keytool" -exportcert -alias "$TASK_KIND" -keystore "$TASK_WORK/$TASK_KIND.p12" -storepass:file "$TASK_WORK/password" -file "$TASK_WORK/$TASK_KIND.cer" >/dev/null 2>&1
 "$TASK_JDK/bin/keytool" -importcert -noprompt -alias "$TASK_KIND" -keystore "$TASK_WORK/trust.p12" -storepass:file "$TASK_WORK/password" -file "$TASK_WORK/$TASK_KIND.cer" >/dev/null 2>&1
done
TASK_BUILD_DIR=${TASK_BUILD_DIR:-$TASK_PARENT/build}
TASK_CP=$TASK_BUILD_DIR/classes:$TASK_BUILD_DIR/json.jar:$TASK_SDK/platforms/android-34/android.jar
"$TASK_JDK/bin/javac" --release 8 -Xlint:-options -cp "$TASK_CP" -d "$TASK_WORK" "$TASK_DIR/IpIdentityTest.java"
"$TASK_JDK/bin/java" -cp "$TASK_WORK:$TASK_CP" IpIdentityTest "$TASK_WORK" "$TASK_PARENT/config.example.json"
