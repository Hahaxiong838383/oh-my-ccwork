#!/bin/sh
set -eu
src_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_dir=${VIDEO_BOOT_BUILD_DIR:-/tmp/video-proxy-boot-build}
mkdir -p "$build_dir"
ndk_cc=/home/hahaxiong83/.local/share/codeg-android-toolchain/android-sdk/ndk/26.0.10792818/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi30-clang
"$ndk_cc" -std=c11 -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now "$src_dir/video-boot-net.c" -o "$build_dir/video-boot-net"
toolchain=/home/hahaxiong83/.local/share/codeg-android-toolchain
java_bin="$toolchain/jdk-21/bin"
android_jar="$toolchain/android-sdk/platforms/android-34/android.jar"
d8_jar="$toolchain/android-sdk/build-tools/34.0.0/lib/d8.jar"
mkdir -p "$build_dir/java" "$build_dir/dex"
"$java_bin/javac" --release 8 -Xlint:all,-options -Werror -d "$build_dir/java" "$src_dir/VideoDnsCache.java"
"$java_bin/java" -cp "$d8_jar" com.android.tools.r8.D8 --min-api 30 --lib "$android_jar" --output "$build_dir/dex" "$build_dir/java/VideoDnsCache.class"
cp "$build_dir/dex/classes.dex" "$build_dir/video-dns-cache.dex"
# Record only public tool/source/artifact checksums; no device config is read.
sha256sum "$ndk_cc" "$java_bin/javac" "$java_bin/java" "$d8_jar" "$android_jar" \
  "$src_dir/video-boot-net.c" "$src_dir/VideoDnsCache.java" "$src_dir/video-boot-start.sh" \
  "$build_dir/video-boot-net" "$build_dir/video-dns-cache.dex" > "$build_dir/SHA256SUMS"
cat "$build_dir/SHA256SUMS"
