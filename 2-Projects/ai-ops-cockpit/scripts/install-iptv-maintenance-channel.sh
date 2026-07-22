#!/usr/bin/env bash
set -euo pipefail

RACKNERD_ALIAS="${RACKNERD_ALIAS:-racknerd}"
PRODUCTION_ALIAS="${PRODUCTION_ALIAS:-chenchuan-site}"
PRODUCTION_HOST="${PRODUCTION_HOST:-8.218.26.17}"
PRODUCTION_PORT="${PRODUCTION_PORT:-22}"
REMOTE_ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
SECRET_DIR="$REMOTE_ROOT/secrets/iptv-maintenance"
KEY_PATH="$SECRET_DIR/id_ed25519"
KNOWN_HOSTS_PATH="$SECRET_DIR/known_hosts"
TEMP_DIR="$(mktemp -d /tmp/aiops-iptv-maintenance.XXXXXX)"
trap 'rm -rf "$TEMP_DIR"' EXIT

ssh "$RACKNERD_ALIAS" "install -d -m 700 '$SECRET_DIR'; if [ ! -f '$KEY_PATH' ]; then ssh-keygen -q -t ed25519 -N '' -C 'aiops-iptv-maintenance' -f '$KEY_PATH'; fi; chmod 600 '$KEY_PATH'; chmod 644 '$KEY_PATH.pub'"
PUBLIC_KEY="$(ssh "$RACKNERD_ALIAS" "cat '$KEY_PATH.pub'")"
PUBLIC_KEY_B64="$(printf '%s' "$PUBLIC_KEY" | base64 | tr -d '\n')"

HOST_KEY="$(ssh "$PRODUCTION_ALIAS" "cat /etc/ssh/ssh_host_ed25519_key.pub")"
read -r HOST_KEY_TYPE HOST_KEY_BODY _ <<<"$HOST_KEY"
if [ "$PRODUCTION_PORT" = "22" ]; then
  printf '%s %s %s\n' "$PRODUCTION_HOST" "$HOST_KEY_TYPE" "$HOST_KEY_BODY" > "$TEMP_DIR/known_hosts"
else
  printf '[%s]:%s %s %s\n' "$PRODUCTION_HOST" "$PRODUCTION_PORT" "$HOST_KEY_TYPE" "$HOST_KEY_BODY" > "$TEMP_DIR/known_hosts"
fi
scp -q "$TEMP_DIR/known_hosts" "$RACKNERD_ALIAS:$KNOWN_HOSTS_PATH"
ssh "$RACKNERD_ALIAS" "chmod 600 '$KNOWN_HOSTS_PATH'"

ssh "$PRODUCTION_ALIAS" bash -s -- "$PUBLIC_KEY_B64" <<'REMOTE'
set -euo pipefail
PUBLIC_KEY="$(printf '%s' "$1" | base64 --decode)"

if ! id aiops >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash aiops
fi
passwd -l aiops >/dev/null 2>&1 || true
install -d -m 700 -o aiops -g aiops /home/aiops/.ssh

cat > /usr/local/sbin/aiops-iptv-control <<'CONTROL'
#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/stacks/iptv-api
ACTION="${1:-}"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  docker-compose "$@"
}

inspect() {
  python3 - <<'PY'
import datetime
import json
import os
import shutil
import socket
import subprocess


def container_status():
    try:
        raw = subprocess.check_output(
            ["docker", "inspect", "iptv-api", "--format", "{{json .State}}"],
            universal_newlines=True,
            stderr=subprocess.DEVNULL,
        )
        state = json.loads(raw)
        return {
            "active": "active" if state.get("Running") else "inactive",
            "subState": state.get("Status") or "unknown",
            "pid": int(state.get("Pid") or 0),
            "restartCount": 0,
            "activeSince": state.get("StartedAt") or None,
        }
    except Exception:
        return {"active": "unknown", "subState": "unknown", "pid": 0, "restartCount": 0, "activeSince": None}


def command_value(command):
    try:
        return subprocess.check_output(command, universal_newlines=True, stderr=subprocess.DEVNULL).strip()[:160]
    except Exception:
        return None


def iso_age_seconds(value):
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+0000")
        if len(normalized) >= 6 and normalized[-3] == ":":
            normalized = normalized[:-3] + normalized[-2:]
        parsed = datetime.datetime.strptime(normalized, "%Y-%m-%dT%H:%M:%S.%f%z")
        return max(0, round((datetime.datetime.now(datetime.timezone.utc) - parsed).total_seconds()))
    except Exception:
        return None


health = {}
try:
    with open("/var/lib/iptv-aiops/health.json", encoding="utf-8") as handle:
        health = json.load(handle)
except Exception:
    pass
service = container_status()
playlist_updated_at = health.get("generatedAt")
playlist_age = iso_age_seconds(playlist_updated_at)
playlist = {
    "ok": bool(health.get("ok")),
    "status": health.get("status") or "missing",
    "channelCount": int(health.get("channelCount") or 0),
    "samplePassed": int(health.get("samplePassed") or 0),
    "sampleTotal": int(health.get("sampleTotal") or 0),
    "updatedAt": playlist_updated_at,
    "ageSeconds": playlist_age,
}
timer_enabled = command_value(["systemctl", "is-enabled", "iptv-validate-publish.timer"])
timer_active = command_value(["systemctl", "is-active", "iptv-validate-publish.timer"])
scheduler = {
    "ok": timer_enabled == "enabled" and timer_active == "active",
    "enabled": timer_enabled,
    "active": timer_active,
    "nextElapse": command_value(["systemctl", "show", "iptv-validate-publish.timer", "--property=NextElapseUSecRealtime", "--value"]),
    "lastResult": command_value(["systemctl", "show", "iptv-validate-publish.service", "--property=Result", "--value"]),
}
disk = shutil.disk_usage("/")
memory_available_kb = None
with open("/proc/meminfo", encoding="utf-8") as meminfo:
    for line in meminfo:
        if line.startswith("MemAvailable:"):
            memory_available_kb = int(line.split()[1])
            break
payload = {
    "ok": service["active"] == "active" and playlist["ok"] and scheduler["ok"] and playlist_age is not None and playlist_age <= 129600,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "hostname": socket.gethostname(),
    "services": {"iptv-api": service},
    "probes": {"playlist": playlist},
    "scheduler": scheduler,
    "host": {
        "load1": round(os.getloadavg()[0], 2),
        "diskUsedPercent": round((disk.used / disk.total) * 100, 1) if disk.total else None,
        "diskFreeGB": round(disk.free / 1024 / 1024 / 1024, 2),
        "memoryAvailableMB": round(memory_available_kb / 1024, 1) if memory_available_kb else None,
    },
}
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
PY
}

case "$ACTION" in
  inspect)
    inspect
    ;;
  refresh)
    before="$(stat -c %Y "$ROOT/output/ipv4/result.m3u" 2>/dev/null || echo 0)"
    cd "$ROOT"
    compose restart iptv-api >/dev/null
    deadline=$((SECONDS + 660))
    while [ "$SECONDS" -lt "$deadline" ]; do
      after="$(stat -c %Y "$ROOT/output/ipv4/result.m3u" 2>/dev/null || echo 0)"
      if [ "$after" -gt "$before" ]; then
        if "$ROOT/scripts/validate-and-publish.sh" >/dev/null 2>&1; then
          inspect
        else
          printf '{"ok":false,"error":"candidate_rejected","publishedPreserved":true}\n'
        fi
        exit 0
      fi
      sleep 10
    done
    printf '{"ok":false,"error":"refresh_timeout"}\n'
    exit 1
    ;;
  repair-publish-timer)
    "$ROOT/scripts/install-validate-publish-timer.sh" --run-now >/dev/null
    inspect
    ;;
  restart-iptv)
    cd "$ROOT"
    compose restart iptv-api >/dev/null
    sleep 5
    inspect
    ;;
  rollback-last-good)
    "$ROOT/scripts/rollback-last-good.sh" >/dev/null
    inspect
    ;;
  *)
    printf '{"ok":false,"error":"action_not_allowed"}\n'
    exit 64
    ;;
esac
CONTROL
chmod 0755 /usr/local/sbin/aiops-iptv-control
chown root:root /usr/local/sbin/aiops-iptv-control

cat > /usr/local/bin/aiops-iptv-dispatch <<'DISPATCH'
#!/usr/bin/env bash
set -euo pipefail
case "${SSH_ORIGINAL_COMMAND:-}" in
  inspect|refresh|repair-publish-timer|restart-iptv|rollback-last-good)
    exec sudo -n /usr/local/sbin/aiops-iptv-control "$SSH_ORIGINAL_COMMAND"
    ;;
  *)
    printf '{"ok":false,"error":"command_not_allowed"}\n'
    exit 64
    ;;
esac
DISPATCH
chmod 0755 /usr/local/bin/aiops-iptv-dispatch
chown root:root /usr/local/bin/aiops-iptv-dispatch

cat > /etc/sudoers.d/aiops-iptv <<'SUDOERS'
Defaults:aiops !requiretty
aiops ALL=(root) NOPASSWD: /usr/local/sbin/aiops-iptv-control inspect, /usr/local/sbin/aiops-iptv-control refresh, /usr/local/sbin/aiops-iptv-control repair-publish-timer, /usr/local/sbin/aiops-iptv-control restart-iptv, /usr/local/sbin/aiops-iptv-control rollback-last-good
SUDOERS
chmod 0440 /etc/sudoers.d/aiops-iptv
visudo -cf /etc/sudoers.d/aiops-iptv >/dev/null

AUTHORIZED_KEYS=/home/aiops/.ssh/authorized_keys
touch "$AUTHORIZED_KEYS"
grep -v 'aiops-iptv-maintenance' "$AUTHORIZED_KEYS" > "$AUTHORIZED_KEYS.tmp" || true
printf 'restrict,command="/usr/local/bin/aiops-iptv-dispatch" %s\n' "$PUBLIC_KEY" >> "$AUTHORIZED_KEYS.tmp"
mv "$AUTHORIZED_KEYS.tmp" "$AUTHORIZED_KEYS"
chown aiops:aiops "$AUTHORIZED_KEYS"
chmod 0600 "$AUTHORIZED_KEYS"
REMOTE

SSH_COMMAND=(
  ssh -F /dev/null -i "$KEY_PATH" -o BatchMode=yes
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS_PATH"
  -p "$PRODUCTION_PORT" "aiops@$PRODUCTION_HOST"
)

ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} inspect" | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["ok"] is True; assert data["services"]["iptv-api"]["active"]=="active"; assert data["probes"]["playlist"]["channelCount"]>=20; print("iptv maintenance inspect ok")'
if ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} id" >/dev/null 2>&1; then
  printf 'restricted key unexpectedly accepted arbitrary command\n' >&2
  exit 1
fi
printf 'iptv maintenance channel installed\n'
