#!/bin/sh
set -eu
src_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_dir=$(mktemp -d /tmp/video-boot-net-tests.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wno-unused-function -fsanitize=address,undefined -fno-omit-frame-pointer "$src_dir/test-video-boot-net.c" -o "$test_dir/test-net"
ASAN_OPTIONS=detect_leaks=1 "$test_dir/test-net"
cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wno-unused-function -fsanitize=address,undefined -fno-omit-frame-pointer "$src_dir/test-mark-overwrite.c" -o "$test_dir/test-mark"
ASAN_OPTIONS=detect_leaks=1 "$test_dir/test-mark"
cc -std=c11 -O2 -Wall -Wextra -Werror "$src_dir/video-boot-net.c" -o "$test_dir/probe-host"
"$test_dir/probe-host" --help
