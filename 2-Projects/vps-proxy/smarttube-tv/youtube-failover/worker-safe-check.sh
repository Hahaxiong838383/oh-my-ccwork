#!/system/bin/sh
# Read-only API guard; token is loaded inside Java, never in shell arguments.
set -eu
ROOT=${YOUTUBE_FAILOVER_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
case "${1:-}" in rack|zgo) ;; *) exit 2 ;; esac
[ -f "$ROOT/guard.dex" ] || exit 1
CLASSPATH="$ROOT/guard.dex" app_process /system/bin YoutubeFailover --worker-safe "$ROOT/guard-config.json" "$1"
