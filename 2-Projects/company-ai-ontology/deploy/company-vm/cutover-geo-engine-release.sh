#!/usr/bin/env bash
set -euo pipefail

new_release_sha="${1:?new release SHA is required}"
old_release_sha="${2:?old release SHA is required}"
geo_root="/home/futurus/.geo-engine"
new_release="${geo_root}/releases/company-ai-ontology-${new_release_sha}"
new_venv="${geo_root}/venvs/geo-engine-${new_release_sha}"
old_release="${geo_root}/releases/company-ai-ontology-${old_release_sha}"
old_venv="${geo_root}/venvs/geo-engine-${old_release_sha}"

test "$(id -u)" -eq 0
test "$(git -C "${new_release}" rev-parse HEAD)" = "${new_release_sha}"
test "$(git -C "${old_release}" rev-parse HEAD)" = "${old_release_sha}"
test -x "${new_venv}/bin/geo-engine"
test -x "${old_venv}/bin/geo-engine"

rollback() {
    ln -sfn "${old_release}" "${geo_root}/current"
    ln -sfn "${old_venv}" "${geo_root}/current-venv"
    systemctl restart geo-engine.service
    for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
        if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    systemctl restart geo-dashboard-tunnel.service
}

ln -sfn "${new_release}" "${geo_root}/current"
ln -sfn "${new_venv}" "${geo_root}/current-venv"

if ! systemctl restart geo-engine.service; then
    rollback
    exit 1
fi

ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 1
done

if [[ "${ready}" -ne 1 ]]; then
    rollback
    exit 1
fi

stats="$(curl -fsS http://127.0.0.1:8080/stats)"
if ! python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["version"] == "0.3.2"; assert data["generation_model"] == "deepseek-v4-flash"; assert data["reasoning_effort"] == "max"' <<<"${stats}"; then
    rollback
    exit 1
fi

if ! systemctl restart geo-dashboard-tunnel.service; then
    rollback
    exit 1
fi

printf '%s\n' "${stats}"
printf 'release_sha=%s\n' "${new_release_sha}"
