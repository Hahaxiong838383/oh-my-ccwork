#!/usr/bin/env bash
set -euo pipefail
ROOT="${IPTV_ROOT:-/opt/stacks/iptv-api}"
latest=$(find "$ROOT/backups" -maxdepth 1 -type f -name 'result-*.m3u' -printf '%T@ %p\n' | sort -nr | sed -n '2{s/^[^ ]* //;p}')
[ -n "$latest" ] || { echo 'no previous snapshot' >&2; exit 1; }
install -m 0644 "$latest" "$ROOT/published/.result.m3u.tmp"
mv -f "$ROOT/published/.result.m3u.tmp" "$ROOT/published/result.m3u"
printf 'IPTV_ROLLBACK_OK\n'
