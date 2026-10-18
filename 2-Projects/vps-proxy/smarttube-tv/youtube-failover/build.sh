#!/usr/bin/env bash
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
TASK_BUILD_DIR=${TASK_BUILD_DIR:-$TASK_DIR/build}
TASK_JDK=${TASK_JDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/jdk-21}
TASK_SDK=${TASK_SDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk}
export JAVA_HOME="$TASK_JDK"
export PATH="$TASK_JDK/bin:$PATH"
mkdir -p "$TASK_BUILD_DIR/classes" "$TASK_BUILD_DIR/dex"
find "$TASK_BUILD_DIR/classes" -type f -name '*.class' -delete
"$TASK_JDK/bin/javac" --release 8 -Xlint:-options -cp "$TASK_SDK/platforms/android-34/android.jar" -d "$TASK_BUILD_DIR/classes" "$TASK_DIR/YoutubeFailover.java"
"$TASK_SDK/build-tools/34.0.0/d8" --min-api 26 --lib "$TASK_SDK/platforms/android-34/android.jar" --output "$TASK_BUILD_DIR/dex" "$TASK_BUILD_DIR"/classes/*.class
cp "$TASK_BUILD_DIR/dex/classes.dex" "$TASK_DIR/youtube-guard.dex"
chmod 600 "$TASK_DIR/youtube-guard.dex"
printf '%s\n' "$TASK_DIR/youtube-guard.dex"
