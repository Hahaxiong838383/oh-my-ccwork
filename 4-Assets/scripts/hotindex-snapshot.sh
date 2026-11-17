#!/bin/bash
# hotindex-snapshot.sh — 每日快照 canonical 的 MEMORY.md / INDEX-full.md（2026-09-18 被并发会话整文件覆盖后补的恢复路径）。
# 保留 30 天；不入 git（backups/hotindex-daily 已 ignore）。恢复：cp <快照> <canonical>。
set -uo pipefail
SRC="$HOME/.claude/projects/-home-hahaxiong83-mycc/memory"; DST="$HOME/.mycc-global/backups/hotindex-daily"; D=$(date +%F)
mkdir -p "$DST"
for f in MEMORY.md INDEX-full.md; do
  [ -f "$SRC/$f" ] || { echo "skip $f: missing"; continue; }
  cp -p "$SRC/$f" "$DST/$f.$D" && echo "snap $f.$D $(wc -c < "$DST/$f.$D")B"
done
find "$DST" -name '*.md.20*' -mtime +30 -delete
