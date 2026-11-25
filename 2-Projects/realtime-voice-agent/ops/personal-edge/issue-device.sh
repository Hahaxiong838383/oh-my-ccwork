#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ ! -t 1 ]]
owner="${1:?owner required}"
device="${2:?device required}"
[[ "$owner" =~ ^[a-z0-9][a-z0-9-]{0,31}$ && "$device" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]
umask 077
temp=$(mktemp -d)
trap 'rm -f "$temp/receiver.key"; rmdir "$temp"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$temp/receiver.key" 2>/dev/null
public=$(openssl pkey -in "$temp/receiver.key" -pubout | base64 -w0)
{
    printf '%s\n' '#!/bin/bash' 'set -euo pipefail'
    printf "owner='%s'\ndevice='%s'\npublic='%s'\n" "$owner" "$device" "$public"
    cat <<'ECS'
cd /opt/personal-edge
temp=$(mktemp -d -p private)
trap 'rm -f "$temp/credential"; rmdir "$temp"' EXIT
python3 -B ticket.py add "$owner" "$device" --output "$temp/credential" >/dev/null
openssl pkeyutl -encrypt -pubin -inkey <(printf '%s' "$public" | base64 -d) \
    -in "$temp/credential" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 | base64 -w0
ECS
} | python3 -B ecs-run.py issue-device | base64 -d | openssl pkeyutl -decrypt \
    -inkey "$temp/receiver.key" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256
