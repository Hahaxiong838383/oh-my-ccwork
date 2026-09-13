#!/usr/bin/env bash
# B89 后台单页替换(单文件 cp 形态,永不 rsync --delete)。回滚:cp 备份回原位即可,无重启。
set -uo pipefail
F=/opt/p003/web/dist/admin/index.html; ST=/tmp/b89-stage/index.html; TS=$(date -u +%Y%m%d-%H%M%S)
m() { md5sum "$1" | cut -c1-32; }
[ "$(m $F)" = "e5fad89d73f5abaacc3a789a9f09f8aa" ] || { echo "ABORT prod admin html drift: $(m $F)"; exit 10; }
[ "$(m $ST)" = "110bba0c6d401b11b2d5fb6b8923f3ee" ] || { echo "ABORT staged html md5: $(m $ST)"; exit 11; }
cp -p "$F" "$F.bak-$TS-b89" && echo "backup: $F.bak-$TS-b89"
cp -p "$ST" "$F"
[ "$(m $F)" = "110bba0c6d401b11b2d5fb6b8923f3ee" ] && echo "admin html = 110bba0c6d401b11b2d5fb6b8923f3ee ✓ ($(stat -c %s $F) bytes)" || { echo "ABORT — restoring"; cp -p "$F.bak-$TS-b89" "$F"; exit 12; }
echo "== DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
