#!/usr/bin/env bash
set -euo pipefail
src=$(cd -- "$(dirname -- "$0")" && pwd)
out=${TASK_BUILD_DIR:-/tmp/video-proc-scan-build}
compiler=${TASK_ANDROID_CC:-/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk/ndk/26.0.10792818/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi30-clang}
mkdir -p "$out"
"$compiler" -std=c11 -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now \
  "$src/video-proc-scan.c" -o "$out/video-proc-scan"
sha256sum "$out/video-proc-scan"
