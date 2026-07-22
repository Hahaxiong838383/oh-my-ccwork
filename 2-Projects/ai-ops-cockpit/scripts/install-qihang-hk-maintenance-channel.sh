#!/usr/bin/env bash
set -euo pipefail
set +x

RACKNERD_ALIAS="${RACKNERD_ALIAS:-racknerd}"
PRODUCTION_HOST="${PRODUCTION_HOST:-64.90.13.117}"
PRODUCTION_PORT="${PRODUCTION_PORT:-22}"
PRODUCTION_USER="${PRODUCTION_USER:-root}"
PRODUCTION_ALIAS="${PRODUCTION_ALIAS:-}"
PRODUCTION_BOOTSTRAP_KNOWN_HOSTS="${PRODUCTION_BOOTSTRAP_KNOWN_HOSTS:-/tmp/qihang-hk-known_hosts}"
REMOTE_ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
SECRET_DIR="$REMOTE_ROOT/secrets/qihang-hk-maintenance"
KEY_PATH="$SECRET_DIR/id_ed25519"
KNOWN_HOSTS_PATH="$SECRET_DIR/known_hosts"
TEMP_DIR="$(mktemp -d /tmp/aiops-qihang-hk.XXXXXX)"
trap 'rm -rf "$TEMP_DIR"' EXIT

production_ssh() {
  local target
  if [ -n "$PRODUCTION_ALIAS" ]; then
    target="$PRODUCTION_ALIAS"
  else
    target="$PRODUCTION_USER@$PRODUCTION_HOST"
  fi
  if [ -n "${SSHPASS:-}" ]; then
    sshpass -e ssh -F /dev/null \
      -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no \
      -o StrictHostKeyChecking=yes \
      -o "UserKnownHostsFile=$PRODUCTION_BOOTSTRAP_KNOWN_HOSTS" \
      -p "$PRODUCTION_PORT" "$target" "$@"
  else
    ssh -o StrictHostKeyChecking=yes -p "$PRODUCTION_PORT" "$target" "$@"
  fi
}

ssh "$RACKNERD_ALIAS" "install -d -m 700 '$SECRET_DIR'; if [ ! -f '$KEY_PATH' ]; then ssh-keygen -q -t ed25519 -N '' -C 'aiops-qihang-hk-maintenance' -f '$KEY_PATH'; fi; chmod 600 '$KEY_PATH'; chmod 644 '$KEY_PATH.pub'"
PUBLIC_KEY="$(ssh "$RACKNERD_ALIAS" "cat '$KEY_PATH.pub'")"
PUBLIC_KEY_B64="$(printf '%s' "$PUBLIC_KEY" | base64 | tr -d '\n')"

HOST_KEY="$(production_ssh 'cat /etc/ssh/ssh_host_ed25519_key.pub')"
read -r HOST_KEY_TYPE HOST_KEY_BODY _ <<<"$HOST_KEY"
if [ "$PRODUCTION_PORT" = "22" ]; then
  printf '%s %s %s\n' "$PRODUCTION_HOST" "$HOST_KEY_TYPE" "$HOST_KEY_BODY" > "$TEMP_DIR/known_hosts"
else
  printf '[%s]:%s %s %s\n' "$PRODUCTION_HOST" "$PRODUCTION_PORT" "$HOST_KEY_TYPE" "$HOST_KEY_BODY" > "$TEMP_DIR/known_hosts"
fi
scp -q "$TEMP_DIR/known_hosts" "$RACKNERD_ALIAS:$KNOWN_HOSTS_PATH"
ssh "$RACKNERD_ALIAS" "chmod 600 '$KNOWN_HOSTS_PATH'"

production_ssh bash -s -- "$PUBLIC_KEY_B64" <<'REMOTE'
set -euo pipefail
PUBLIC_KEY="$(printf '%s' "$1" | base64 --decode)"
BACKUP_DIR="/var/backups/aiops-qihang-hk/pre-install-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$BACKUP_DIR"
for path in \
  /usr/local/sbin/aiops-voice-worker-control \
  /usr/local/bin/aiops-voice-worker-dispatch \
  /etc/sudoers.d/aiops-voice-worker \
  /home/aiops/.ssh/authorized_keys; do
  if [ -e "$path" ]; then
    cp -a --parents "$path" "$BACKUP_DIR"
  fi
done

if ! id aiops >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash aiops
fi
passwd -l aiops >/dev/null 2>&1 || true
install -d -m 700 -o aiops -g aiops /home/aiops/.ssh

cat > /usr/local/sbin/aiops-voice-worker-control <<'CONTROL'
#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ACTION="${1:-}"

inspect() {
  python3 - <<'PY'
import datetime
import json
import os
import shutil
import socket
import subprocess
import time
import urllib.request


def unit_value(prop):
    try:
        return subprocess.check_output(
            ["systemctl", "show", "voice-worker.service", "--property=" + prop, "--value"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()[:160]
    except Exception:
        return None


def warning_count():
    try:
        raw = subprocess.check_output(
            ["journalctl", "-u", "voice-worker.service", "--since", "24 hours ago", "-p", "warning", "--no-pager", "-q"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        return len([line for line in raw.splitlines() if line.strip()])
    except Exception:
        return None


active = unit_value("ActiveState") or "unknown"
sub_state = unit_value("SubState") or "unknown"
pid = int(unit_value("MainPID") or 0)
restart_count = int(unit_value("NRestarts") or 0)
active_since = unit_value("ActiveEnterTimestamp")
port_listening = subprocess.run(
    ["sh", "-lc", "ss -ltnH 'sport = :8081' | grep -q ."],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
).returncode == 0
probe = {"ok": False, "status": None, "latencyMs": None, "bytes": 0}
started = time.time()
try:
    request = urllib.request.Request("http://127.0.0.1:8081/", headers={"User-Agent": "AI-Ops-Cockpit/1.0"})
    with urllib.request.urlopen(request, timeout=5) as response:
        body = response.read(4096)
        probe.update({"ok": response.status == 200, "status": response.status, "bytes": len(body)})
except Exception as exc:
    probe["error"] = type(exc).__name__
probe["latencyMs"] = round((time.time() - started) * 1000)
disk = shutil.disk_usage("/")
memory_available_kb = 0
with open("/proc/meminfo", encoding="utf-8") as meminfo:
    for line in meminfo:
        if line.startswith("MemAvailable:"):
            memory_available_kb = int(line.split()[1])
            break
service = {
    "active": active,
    "subState": sub_state,
    "pid": pid,
    "restartCount": restart_count,
    "activeSince": active_since,
}
payload = {
    "ok": active == "active" and sub_state == "running" and port_listening and probe["ok"],
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "hostname": socket.gethostname(),
    "services": {"voice-worker": service},
    "ports": {"8081": port_listening},
    "probes": {"voiceWorker": probe},
    "logs": {"warning24h": warning_count()},
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
  restart-voice-worker)
    systemctl restart voice-worker.service
    sleep 3
    inspect
    ;;
  *)
    printf '{"ok":false,"error":"action_not_allowed"}\n'
    exit 64
    ;;
esac
CONTROL
chmod 0755 /usr/local/sbin/aiops-voice-worker-control
chown root:root /usr/local/sbin/aiops-voice-worker-control

cat > /usr/local/bin/aiops-voice-worker-dispatch <<'DISPATCH'
#!/usr/bin/env bash
set -euo pipefail
case "${SSH_ORIGINAL_COMMAND:-}" in
  inspect|restart-voice-worker)
    exec sudo -n /usr/local/sbin/aiops-voice-worker-control "$SSH_ORIGINAL_COMMAND"
    ;;
  *)
    printf '{"ok":false,"error":"command_not_allowed"}\n'
    exit 64
    ;;
esac
DISPATCH
chmod 0755 /usr/local/bin/aiops-voice-worker-dispatch
chown root:root /usr/local/bin/aiops-voice-worker-dispatch

cat > /etc/sudoers.d/aiops-voice-worker <<'SUDOERS'
Defaults:aiops !requiretty
aiops ALL=(root) NOPASSWD: /usr/local/sbin/aiops-voice-worker-control inspect, /usr/local/sbin/aiops-voice-worker-control restart-voice-worker
SUDOERS
chmod 0440 /etc/sudoers.d/aiops-voice-worker
visudo -cf /etc/sudoers.d/aiops-voice-worker >/dev/null

AUTHORIZED_KEYS=/home/aiops/.ssh/authorized_keys
touch "$AUTHORIZED_KEYS"
grep -v 'aiops-qihang-hk-maintenance' "$AUTHORIZED_KEYS" > "$AUTHORIZED_KEYS.tmp" || true
printf 'restrict,command="/usr/local/bin/aiops-voice-worker-dispatch" %s\n' "$PUBLIC_KEY" >> "$AUTHORIZED_KEYS.tmp"
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

ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} inspect" | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["ok"] is True; assert data["services"]["voice-worker"]["active"]=="active"; assert data["ports"]["8081"] is True; assert data["probes"]["voiceWorker"]["status"]==200; print("qihang hk maintenance inspect ok")'
if ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} id" >/dev/null 2>&1; then
  printf 'restricted key unexpectedly accepted arbitrary command\n' >&2
  exit 1
fi
printf 'qihang hk maintenance channel installed\n'
