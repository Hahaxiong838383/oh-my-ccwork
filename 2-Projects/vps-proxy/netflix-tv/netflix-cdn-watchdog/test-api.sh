#!/usr/bin/env bash
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
TASK_JDK=${TASK_JDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/jdk-21}
TASK_SDK=${TASK_SDK:-/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk}
TASK_TEST_DIR="$TASK_DIR/build/api-test"
TASK_JSON_JAR="$TASK_DIR/build/test-deps/json-20240303.jar"
umask 077
mkdir -p "$TASK_TEST_DIR"
"$TASK_JDK/bin/javac" --release 8 -cp "$TASK_DIR/build/classes:$TASK_JSON_JAR:$TASK_SDK/platforms/android-34/android.jar" -d "$TASK_TEST_DIR" "$TASK_DIR/WatchdogApiTest.java"
"$TASK_JDK/bin/java" -cp "$TASK_TEST_DIR:$TASK_DIR/build/classes:$TASK_JSON_JAR:$TASK_SDK/platforms/android-34/android.jar" WatchdogApiTest
