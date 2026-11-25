#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if (( $# > 1 )) || [[ -n "${1:-}" && "$1" != --pki-only ]]; then
    printf 'Usage: bash deploy.sh [--pki-only]\n' >&2
    exit 2
fi
payload=$(tar -czf - ticket.py livekit.yaml nginx.conf install.sh personal-edge-*.service | base64 -w0)
{
    printf '%s\n' 'set -eu' 'install -d -m 0755 /opt/personal-edge' 'cd /opt/personal-edge'
    printf "printf '%%s' '%s' | base64 -d | tar --no-same-owner -xzf -\n" "$payload"
    printf 'exec bash ./install.sh %s\n' "${1:-}"
} | python3 -B ecs-run.py install --timeout 150
