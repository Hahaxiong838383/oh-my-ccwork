#!/usr/bin/env bash
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
TASK_JDK=${TASK_JDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/jdk-21}
TASK_SDK=${TASK_SDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk}
export JAVA_HOME="$TASK_JDK"
export PATH="$TASK_JDK/bin:$PATH"
mkdir -p "$TASK_DIR/build/classes" "$TASK_DIR/build/dex"
"$TASK_JDK/bin/javac" --release 8 -cp "$TASK_SDK/platforms/android-34/android.jar" -d "$TASK_DIR/build/classes" "$TASK_DIR/NetflixCdnWatchdog.java"
"$TASK_SDK/build-tools/34.0.0/d8" --min-api 26 --lib "$TASK_SDK/platforms/android-34/android.jar" --output "$TASK_DIR/build/dex" "$TASK_DIR"/build/classes/*.class
cp "$TASK_DIR/build/dex/classes.dex" "$TASK_DIR/watchdog.dex"
chmod 600 "$TASK_DIR/watchdog.dex"
printf '%s\n' "$TASK_DIR/watchdog.dex"
