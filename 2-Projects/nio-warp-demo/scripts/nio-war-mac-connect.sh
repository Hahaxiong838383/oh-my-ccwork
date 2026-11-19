#!/bin/sh
# Prefer EasyTier; fall back to reserved LAN Wi-Fi address on TCP unreachability.
# --lan-only is for verification without disrupting the mesh service.
set -eu
if [ "${1:-}" != "--lan-only" ] && /usr/bin/nc -z -G 2 -w 2 10.10.10.14 22 >/dev/null 2>&1; then
  exec /usr/bin/nc -G 8 10.10.10.14 22
fi
exec /usr/bin/nc -G 8 10.9.1.230 22
