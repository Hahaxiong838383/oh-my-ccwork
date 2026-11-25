#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/personal-edge
public_ip=60.205.5.246
version=1.13.11
asset_sha=1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb

install -d -m 0755 bin pki public
install -d -m 0700 private
if [[ ! -s pki/server.crt ]]; then
    if [[ ! -s pki/ca.crt ]]; then
        openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 730 \
            -subj '/CN=Personal Voice Edge Pilot CA' \
            -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
            -addext 'keyUsage=critical,keyCertSign,cRLSign' \
            -keyout private/ca.key -out pki/ca.crt 2>/dev/null
    fi
    openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$public_ip" \
        -keyout private/server.key -out private/server.csr 2>/dev/null
    openssl x509 -req -sha256 -days 365 -in private/server.csr \
        -CA pki/ca.crt -CAkey private/ca.key -set_serial "0x$(openssl rand -hex 16)" \
        -extfile <(printf 'subjectAltName=IP:%s\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$public_ip") \
        -out pki/server.crt 2>/dev/null
    rm -f private/server.csr
fi
chmod 0644 pki/*.crt
openssl verify -CAfile pki/ca.crt -verify_ip "$public_ip" pki/server.crt
if [[ "${1:-}" == --pki-only ]]; then
    exit 0
fi

if [[ ! -x bin/livekit-server ]]; then
    archive=private/livekit-release.tar.gz
    if [[ ! -s "$archive" ]]; then
        archive=$(mktemp -p private)
        trap 'rm -f "$archive" bin/livekit-server.new' EXIT
        curl --fail --silent --show-error --location --connect-timeout 8 --max-time 45 \
            "https://github.com/livekit/livekit/releases/download/v${version}/livekit_${version}_linux_amd64.tar.gz" \
            --output "$archive"
    fi
    printf '%s  %s\n' "$asset_sha" "$archive" | sha256sum --check --status
    tar -xOf "$archive" livekit-server > bin/livekit-server.new
    install -m 0755 bin/livekit-server.new bin/livekit-server
    rm -f "$archive" bin/livekit-server.new
fi
bin/livekit-server --version

for role in ticket worker; do
    if [[ ! -e "private/$role.keys" ]]; then
        printf 'pv_%s: %s\n' "$(openssl rand -hex 12)" "$(openssl rand -hex 32)" > "private/$role.keys.new"
        mv -T "private/$role.keys.new" "private/$role.keys"
    fi
done
cat private/ticket.keys private/worker.keys > private/livekit.keys.new
mv -T private/livekit.keys.new private/livekit.keys
systemctl enable --now /opt/personal-edge/personal-edge-{livekit,ticket,gateway}.service
for _ in {1..15}; do
    if curl -fsS --max-time 2 http://127.0.0.1:18780/ >/dev/null &&
       curl -fsS --max-time 2 --cacert pki/ca.crt \
           --resolve "$public_ip:18784:127.0.0.1" "https://$public_ip:18784/healthz"; then
        break
    fi
    sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:18780/ >/dev/null
curl -fsS --max-time 3 --cacert pki/ca.crt \
    --resolve "$public_ip:18784:127.0.0.1" "https://$public_ip:18784/healthz"
printf '\n'
ufw allow 18784/tcp comment 'personal-edge HTTPS WSS'
ufw allow 18782/tcp comment 'personal-edge WebRTC ICE TCP'
ufw allow 18782/udp comment 'personal-edge WebRTC ICE UDP'
ufw allow 18785/udp comment 'personal-edge authenticated TURN UDP'
systemctl is-active personal-edge-{livekit,ticket,gateway}
sha256sum bin/livekit-server ticket.py nginx.conf livekit.yaml
