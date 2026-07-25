#!/usr/bin/env bash
set -euo pipefail

ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
CRON_FILE=/etc/cron.d/aiops-omp-auto-update

if [ -f "$CRON_FILE" ]; then
  cp "$CRON_FILE" "$CRON_FILE.bak.$(date +%Y%m%d-%H%M%S)"
fi

TMP_FILE="$(mktemp)"
cat > "$TMP_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CRON_TZ=Asia/Shanghai
20 5 * * * root cd $ROOT && scripts/update-omp.sh 2>&1 | logger -t aiops-omp-update
EOF
chmod 0644 "$TMP_FILE"
mv "$TMP_FILE" "$CRON_FILE"
printf 'installed %s\n' "$CRON_FILE"
