#!/bin/zsh
set -euo pipefail

LABEL=com.futurus.company-ontology-tunnel
SCRIPT_DIR=${0:A:h}
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$UID"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed "s|__HOME__|$HOME|g" "$SCRIPT_DIR/$LABEL.plist.template" > "$TARGET.tmp"
plutil -lint "$TARGET.tmp" >/dev/null
mv "$TARGET.tmp" "$TARGET"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

for _ in {1..20}; do
  if ssh aliyun-hk "curl -fsS --max-time 3 http://127.0.0.1:19180/healthz >/dev/null"; then
    print "company ontology tunnel ready"
    exit 0
  fi
  sleep 1
done

print -u2 "company ontology tunnel failed readiness check"
exit 1
