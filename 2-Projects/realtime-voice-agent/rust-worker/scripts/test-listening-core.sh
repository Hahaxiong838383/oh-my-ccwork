#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/p003-listening-core.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
# Pure state/buffer tests only. This is NOT the complete Cargo/Linux/RTC suite.
rustc --edition=2021 --test tests/listening_core.rs -o "$test_dir/listening-core"
"$test_dir/listening-core"
