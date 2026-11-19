#!/bin/sh
# Read-only rehearsal: checks rollback data without changing Git, apps or defaults.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
TAG=nio-warp-before-bezier-20260917
EXPECTED_COMMIT=51513d4dbf533ad7955f65b0c4aca4a6a1c4c5a6

verify() {
    actual=$(shasum -a 256 "$1" | awk '{print $1}')
    if [ "$actual" != "$2" ]; then
        printf '校验失败：%s\n' "$1" >&2
        exit 1
    fi
    printf 'SHA256 通过：%s\n' "$1"
}

actual_commit=$(git -C "$PROJECT_DIR" rev-parse "$TAG^{commit}")
[ "$actual_commit" = "$EXPECTED_COMMIT" ] || { printf '回滚标签不匹配\n' >&2; exit 1; }
printf 'Git 标签通过：%s → %s\n' "$TAG" "$actual_commit"
verify "$PROJECT_DIR/.rollback/20260917-before-bezier/source.tar" c050deadaa906b2350d20c3840f2108bebe320e694ac8523914394e23c12439b
tar -tf "$PROJECT_DIR/.rollback/20260917-before-bezier/source.tar" >/dev/null

if [ "$#" -gt 0 ]; then
    verify "$1/NIOWarpApp-v0.9.10-25.zip" cc6741e20afe01cb587b491b1fa7a208b029e182c4f367d48a375887f24cf688
    verify "$1/warp-defaults.plist" c504dfbdff33e3c0121b28f2a5ce7484fffe729e52e7ff11a211eb26d7e56cad
    plutil -lint "$1/warp-defaults.plist"
else
    printf '开发机 App/偏好归档未在本机复验；可传入其备份目录单独校验。\n'
fi
printf '只读演练完成；未修改源码、安装版或当前参数。\n'
