#!/system/bin/sh
# Restore only the next-boot entry. Never starts/stops a service or changes time.
set -eu
umask 077
D=/data/adb/video-proxy
B="$D/backup-20261018-boot-clock"
expected=d4b8585e364ae2661fbd142e1f81b8db05727a59fcfb28dafc7836201f5c88b5
actual=$(sha256sum "$B/video-proxy.sh" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo 'rollback backup checksum mismatch' >&2; exit 1; }
case "${1:-}" in
  --verify)
    check="$B/restore-check.sh"
    cp "$B/video-proxy.sh" "$check"
    chmod 700 "$check"
    sh -n "$check"
    [ "$(sha256sum "$check" | cut -d ' ' -f 1)" = "$expected" ]
    rm "$check"
    echo 'rollback copy and shell syntax verified; active entry unchanged'
    ;;
  --restore-next-boot)
    cp "$B/video-proxy.sh" /data/adb/service.d/video-proxy.sh.restore
    chmod 700 /data/adb/service.d/video-proxy.sh.restore
    sh -n /data/adb/service.d/video-proxy.sh.restore
    mv /data/adb/service.d/video-proxy.sh.restore /data/adb/service.d/video-proxy.sh
    echo 'previous next-boot entry restored; running services untouched'
    ;;
  *) echo 'Use --verify or --restore-next-boot; this script never restarts services.' >&2; exit 2 ;;
esac
