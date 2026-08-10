#!/bin/sh
set -eu

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
foundation_root=${FOUNDATION_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
shadow_root=${SI_SHADOW_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence}
expected_host=${EXPECTED_QNAP_HOST:-PRNas}
expected_model=${EXPECTED_QNAP_MODEL:-TS-X65}
expected_ip=${EXPECTED_QNAP_IP:-192.168.61.18}

[ "$(hostname)" = "$expected_host" ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ "$foundation_root" = /share/CACHEDEV1_DATA/ai-ontology/foundation ] || { echo 'refusing unexpected company ontology root' >&2; exit 1; }
case "$shadow_root" in /share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence) ;; *) echo 'refusing unexpected strategic intelligence root' >&2; exit 1 ;; esac
[ -x "$docker_path" ] || { echo 'QNAP Container Station docker not found' >&2; exit 1; }

model=$(getcfg 'System' 'Model' -f /etc/config/uLinux.conf 2>/dev/null || true)
[ "$model" = "$expected_model" ] || { echo 'refusing unexpected QNAP model' >&2; exit 1; }
ip -4 addr show | grep -F " $expected_ip/" >/dev/null || { echo 'refusing unexpected QNAP address' >&2; exit 1; }

printf 'company_qnap_identity=verified\nfoundation_root=%s\nshadow_root=%s\n' "$foundation_root" "$shadow_root"
