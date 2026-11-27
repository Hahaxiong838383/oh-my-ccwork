#!/bin/sh
# Android NDK r26, ARMv7 Android 11. Supply output paths on the build volume.
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo 'usage: build-x96-gw-probe.sh PROBE_OUTPUT [DNS_CONNTRACK_OUTPUT]' >&2
    exit 2
fi
: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to the installed Android NDK 26.0.10792818}"
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cc="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/armv7a-linux-androideabi30-clang"
build() {
    "$cc" -std=c11 -Oz -Wall -Wextra -Werror -fPIE -pie -fstack-protector-strong \
      -D_FORTIFY_SOURCE=2 -Wl,-z,relro,-z,now,-s,--build-id=sha1 "$src/$1.c" -o "$2"
    sha256sum "$2"
}
build x96-gw-probe "$1"
if [ "$#" = 2 ]; then build x96-dns-conntrack "$2"; fi
