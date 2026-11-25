#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
host=hahaxiong83@192.168.1.115
ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
private=/vol1/1000/docker/personal-voice-runtime/private
handoff=$(ssh "${ssh_args[@]}" "$host" "set -eu; umask 077; mkdir -p '$private';
    test ! -L '$private'; test ! -e '$private/livekit.env';
    tmp=\$(mktemp -d '$private/.edge-handoff.XXXXXXXX');
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out \"\$tmp/receiver.key\" 2>/dev/null;
    printf '%s' \"\$tmp\"")
trap 'ssh "${ssh_args[@]}" "$host" "rm -f \"$handoff/receiver.key\" \"$handoff/livekit.env\" \"$handoff/ca.crt\" \"$handoff/ca-bundle.crt\"; rmdir \"$handoff\""' EXIT
public=$(ssh "${ssh_args[@]}" "$host" "openssl pkey -in '$handoff/receiver.key' -pubout | base64 -w0")
{
    printf '%s\n' '#!/bin/bash' 'set -euo pipefail'
    printf "public='%s'\n" "$public"
    cat <<'ECS'
cd /opt/personal-edge
IFS= read -r pair < private/worker.keys
{
    printf 'LIVEKIT_URL=wss://60.205.5.246:18784\n'
    printf 'LIVEKIT_API_KEY=%s\n' "${pair%%: *}"
    printf 'LIVEKIT_API_SECRET=%s\n' "${pair#*: }"
} | openssl pkeyutl -encrypt -pubin -inkey <(printf '%s' "$public" | base64 -d) \
    -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 | base64 -w0
ECS
} | python3 -B ecs-run.py wrap-worker-key | ssh "${ssh_args[@]}" "$host" "set -eu; umask 077;
    base64 -d | openssl pkeyutl -decrypt -inkey '$handoff/receiver.key' \
      -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 > '$handoff/livekit.env';
    grep -q '^LIVEKIT_URL=wss://60\.205\.5\.246:18784$' '$handoff/livekit.env';
    grep -q '^LIVEKIT_API_KEY=pv_[a-f0-9]\{24\}$' '$handoff/livekit.env';
    grep -q '^LIVEKIT_API_SECRET=[a-f0-9]\{64\}$' '$handoff/livekit.env'"
printf '%s\n' 'cat /opt/personal-edge/pki/ca.crt' | python3 -B ecs-run.py public-ca |
    ssh "${ssh_args[@]}" "$host" "set -eu; umask 077; cat > '$handoff/ca.crt';
        openssl x509 -in '$handoff/ca.crt' -noout -fingerprint -sha256;
        cat /etc/ssl/certs/ca-certificates.crt '$handoff/ca.crt' > '$handoff/ca-bundle.crt';
        curl --fail --silent --show-error --max-time 10 --noproxy '*' \
            --cacert '$handoff/ca.crt' https://60.205.5.246:18784/healthz;
        printf '\n';
        chmod 0600 '$handoff/livekit.env' '$handoff/ca.crt' '$handoff/ca-bundle.crt';
        ln -T '$handoff/ca.crt' '$private/edge-ca.crt';
        ln -T '$handoff/ca-bundle.crt' '$private/edge-ca-bundle.crt';
        ln -T '$handoff/livekit.env' '$private/livekit.env';
        stat -c '%a %U:%G %n' '$private/livekit.env' '$private/edge-ca-bundle.crt'"
