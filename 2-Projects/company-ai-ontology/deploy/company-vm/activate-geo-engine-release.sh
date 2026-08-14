#!/usr/bin/env bash
set -euo pipefail

release_sha="${1:?release SHA is required}"
release_root="/home/futurus/.geo-engine/releases/company-ai-ontology-${release_sha}"
venv_root="/home/futurus/.geo-engine/venvs/geo-engine-${release_sha}"
deploy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_root="/home/futurus/.geo-engine/backups/systemd-cutover-${timestamp}"

test "$(id -u)" -eq 0
test -d "${release_root}/.git"
test "$(git -C "${release_root}" rev-parse HEAD)" = "${release_sha}"
test -x "${venv_root}/bin/geo-engine"
test -f /home/futurus/.config/geo-engine/geo-engine.env
test "$(stat -c %a /home/futurus/.config/geo-engine/geo-engine.env)" = "600"

install -d -m 0700 -o futurus -g futurus "${backup_root}"
cp -a /etc/systemd/system/geo-dashboard-tunnel.service "${backup_root}/"
cp -a /home/futurus/.config/systemd/user/geo-engine.service "${backup_root}/geo-engine.user.service"
tar -C /home/futurus -czf "${backup_root}/geo-engine-source-before.tar.gz" geo-engine

python3 - "${backup_root}/geo_engine.db" <<'PY'
import sqlite3
import sys

source = sqlite3.connect("file:/home/futurus/.geo-engine/geo_engine.db?mode=ro", uri=True)
target = sqlite3.connect(sys.argv[1])
source.backup(target)
target.close()
source.close()
PY

chown futurus:futurus "${backup_root}/geo_engine.db"
chmod 0600 "${backup_root}/geo_engine.db"
chmod 0600 /home/futurus/.geo-engine/geo_engine.db
ln -sfn "${release_root}" /home/futurus/.geo-engine/current
ln -sfn "${venv_root}" /home/futurus/.geo-engine/current-venv
install -m 0644 "${deploy_root}/geo-engine.service" /etc/systemd/system/geo-engine.service
install -m 0644 "${deploy_root}/geo-dashboard-tunnel.service" /etc/systemd/system/geo-dashboard-tunnel.service
systemctl daemon-reload
systemctl enable geo-engine.service geo-dashboard-tunnel.service
printf 'backup_root=%s\n' "${backup_root}"
