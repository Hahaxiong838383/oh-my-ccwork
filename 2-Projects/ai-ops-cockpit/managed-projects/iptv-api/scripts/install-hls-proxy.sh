#!/usr/bin/env bash
# Install / refresh personal HLS proxy on HK IPTV host.
set -euo pipefail
ROOT="${IPTV_ROOT:-/opt/stacks/iptv-api}"
UNIT=/etc/systemd/system/iptv-hls-proxy.service

install -d -m 755 "$ROOT/scripts" "$ROOT/proxy" "$ROOT/published" /var/log/iptv-aiops
chmod 755 "$ROOT/scripts/hls-proxy.py" "$ROOT/scripts/rewrite-m3u-via-proxy.py" 2>/dev/null || true

# Preserve existing token if present
TOKEN=""
PUBLIC_BASE="https://kidshub-ai.hahaxiong.cc/iptv-proxy"
if [ -f "$ROOT/proxy/config.json" ]; then
  TOKEN=$(python3 -c 'import json;print(json.load(open("/opt/stacks/iptv-api/proxy/config.json")).get("token",""))' 2>/dev/null || true)
  PUBLIC_BASE=$(python3 -c 'import json;print(json.load(open("/opt/stacks/iptv-api/proxy/config.json")).get("public_base","https://kidshub-ai.hahaxiong.cc/iptv-proxy"))' 2>/dev/null || true)
fi
if [ -z "$TOKEN" ] && [ -f /etc/nginx/snippets/iptv-private.conf ]; then
  TOKEN=$(python3 - <<'PY'
import re
from pathlib import Path
text=Path('/etc/nginx/snippets/iptv-private.conf').read_text()
m=re.search(r'location = /iptv/([^/]+)/m3u', text)
print(m.group(1) if m else '')
PY
)
fi
if [ -z "$TOKEN" ]; then
  TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')
fi

python3 - <<PY
import json
from pathlib import Path
cfg_path=Path("$ROOT/proxy/config.json")
old=json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
cfg={
  "token": """$TOKEN""",
  "public_base": """$PUBLIC_BASE""",
  "proxy_groups": ["港澳台", "海外新闻", "海外纪录"],
  "channels": old.get("channels") or {},
}
cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2)+"\n")
cfg_path.chmod(0o600)
print("proxy config ready")
PY

cat > "$UNIT" <<'UNIT'
[Unit]
Description=Personal IPTV HLS reverse proxy (HK jump)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=IPTV_ROOT=/opt/stacks/iptv-api
Environment=IPTV_PROXY_CONFIG=/opt/stacks/iptv-api/proxy/config.json
Environment=IPTV_PROXY_HOST=127.0.0.1
Environment=IPTV_PROXY_PORT=15181
ExecStart=/usr/bin/python3 /opt/stacks/iptv-api/scripts/hls-proxy.py
Restart=always
RestartSec=2
Nice=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/stacks/iptv-api/proxy /var/log/iptv-aiops

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now iptv-hls-proxy.service
systemctl restart iptv-hls-proxy.service
systemctl --no-pager --full status iptv-hls-proxy.service | sed -n '1,15p'

# Nginx snippet for proxy path
SNIP=/etc/nginx/snippets/iptv-hls-proxy.conf
cat > "$SNIP" <<'NGX'
# Personal HLS jump proxy (domestic players -> HK -> origin)
location ^~ /iptv-proxy/ {
    proxy_pass http://127.0.0.1:15181/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
    add_header Cache-Control "private, no-store" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
}
NGX

if ! grep -q 'iptv-hls-proxy.conf' /etc/nginx/sites-enabled/kidshub-ai 2>/dev/null; then
  # insert include near other iptv include if present
  if grep -q 'iptv-private.conf' /etc/nginx/sites-enabled/kidshub-ai; then
    sed -i 's#include /etc/nginx/snippets/iptv-private.conf;#include /etc/nginx/snippets/iptv-private.conf;\n    include /etc/nginx/snippets/iptv-hls-proxy.conf;#' /etc/nginx/sites-enabled/kidshub-ai
  else
    echo "WARN: kidshub-ai site missing iptv-private include; add iptv-hls-proxy manually" >&2
  fi
fi

nginx -t
systemctl reload nginx
echo "iptv hls proxy installed"
EOS
