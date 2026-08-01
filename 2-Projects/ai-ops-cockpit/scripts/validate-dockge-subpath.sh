#!/usr/bin/env bash
set -euo pipefail

cd "${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"

node dockge/test-patch-subpath.mjs
docker compose config -q
docker run --rm \
  -v "$PWD/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2 caddy validate --config /etc/caddy/Caddyfile >/dev/null

if [[ "${1:-}" == "--build" ]]; then
  DOCKER_BUILDKIT=1 docker compose build --no-cache dockge
fi

docker run --rm --entrypoint sh ai-ops-dockge-subpath:1 -lc '
  set -eu
  grep -q '\''src="/dockge/assets/'\'' /app/frontend-dist/index.html
  ! test -e /app/frontend-dist/index.html.gz
  ! test -e /app/frontend-dist/index.html.br
  entry=$(sed -n '\''s#.*src="/dockge/assets/\([^\"]*\.js\)".*#\1#p'\'' /app/frontend-dist/index.html)
  test -n "$entry"
  grep -q '\''path:"/dockge/socket.io"'\'' "/app/frontend-dist/assets/$entry"
  grep -Eq '\''history:[A-Za-z_$][A-Za-z0-9_$]*\("/dockge/"\),routes:'\'' "/app/frontend-dist/assets/$entry"
'

printf 'OK dockge subpath candidate\n'
