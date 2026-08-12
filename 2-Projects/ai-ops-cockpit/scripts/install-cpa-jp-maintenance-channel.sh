#!/usr/bin/env bash
set -euo pipefail

RACKNERD_ALIAS="${RACKNERD_ALIAS:-racknerd}"
PRODUCTION_ALIAS="${PRODUCTION_ALIAS:-aliyun-jp}"
PRODUCTION_HOST="${PRODUCTION_HOST:-47.74.43.55}"
PRODUCTION_PORT="${PRODUCTION_PORT:-52022}"
REMOTE_ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
SECRET_DIR="$REMOTE_ROOT/secrets/cpa-jp-maintenance"
KEY_PATH="$SECRET_DIR/id_ed25519"
KNOWN_HOSTS_PATH="$SECRET_DIR/known_hosts"
TEMP_DIR="$(mktemp -d /tmp/aiops-cpa-maintenance.XXXXXX)"
trap 'rm -rf "$TEMP_DIR"' EXIT

ssh "$RACKNERD_ALIAS" "install -d -m 700 '$SECRET_DIR'; if [ ! -f '$KEY_PATH' ]; then ssh-keygen -q -t ed25519 -N '' -C 'aiops-cpa-jp-maintenance' -f '$KEY_PATH'; fi; chmod 600 '$KEY_PATH'; chmod 644 '$KEY_PATH.pub'"
PUBLIC_KEY="$(ssh "$RACKNERD_ALIAS" "cat '$KEY_PATH.pub'")"
PUBLIC_KEY_B64="$(printf '%s' "$PUBLIC_KEY" | base64 | tr -d '\n')"

HOST_KEY="$(ssh "$PRODUCTION_ALIAS" "cat /etc/ssh/ssh_host_ed25519_key.pub")"
read -r HOST_KEY_TYPE HOST_KEY_BODY _ <<<"$HOST_KEY"
printf '[%s]:%s %s %s\n' "$PRODUCTION_HOST" "$PRODUCTION_PORT" "$HOST_KEY_TYPE" "$HOST_KEY_BODY" > "$TEMP_DIR/known_hosts"
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

cat > /usr/local/sbin/aiops-cpa-jp-control <<'CONTROL'
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
import urllib.error
import urllib.request


def service_status(name):
    raw = subprocess.check_output(
        ["systemctl", "show", name, "--property=ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp", "--no-pager"],
        universal_newlines=True,
        stderr=subprocess.DEVNULL,
    )
    values = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    return {
        "active": values.get("ActiveState"),
        "subState": values.get("SubState"),
        "pid": int(values.get("MainPID") or 0),
        "restartCount": int(values.get("NRestarts") or 0),
        "activeSince": values.get("ActiveEnterTimestamp") or None,
    }


def port_open(port):
    connection = socket.socket()
    connection.settimeout(1.5)
    try:
        return connection.connect_ex(("127.0.0.1", port)) == 0
    finally:
        connection.close()


def request_json(url, api_key, payload=None):
    headers = {"Authorization": "Bearer " + api_key, "User-Agent": "AI-Ops-Restricted-Probe/1.0"}
    body = None
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers)
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read(1048576)
            status = response.status
        return status, json.loads(raw.decode("utf-8")), round((time.time() - started) * 1000)
    except urllib.error.HTTPError as exc:
        exc.read(4096)
        return exc.code, {}, round((time.time() - started) * 1000)
    except Exception:
        return 0, {}, round((time.time() - started) * 1000)


def models_probe(base_url, api_key):
    status, data, latency = request_json(base_url + "/v1/models", api_key)
    models = data.get("data") if isinstance(data, dict) else []
    model_ids = [item.get("id") for item in (models or []) if isinstance(item, dict) and item.get("id")]
    return {"ok": status == 200 and bool(model_ids), "status": status, "modelCount": len(model_ids), "latencyMs": latency}, model_ids


def chat_probe(base_url, api_key, models):
    preferred = ["gpt-5.6-sol", "grok-4.5"]
    model = next((item for item in preferred if item in models), None) or (models[0] if models else None)
    if not model:
        return {"ok": False, "status": 0, "latencyMs": 0}
    status, _, latency = request_json(base_url + "/v1/chat/completions", api_key, {
        "model": model,
        "messages": [{"role": "user", "content": "Reply OK"}],
        "max_tokens": 1,
        "stream": False,
    })
    return {"ok": status == 200, "status": status, "latencyMs": latency}


environment = {}
with open("/etc/cpa-smart-router.env", encoding="utf-8") as env_file:
    for raw_line in env_file:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        environment[key] = value.strip().strip('"').strip("'")

direct_key = environment.get("CPA_API_KEY") or ""
smart_key = environment.get("CPA_SMART_ROUTER_KEY") or ""
direct_models, direct_model_ids = models_probe("http://127.0.0.1:8317", direct_key)
smart_models, smart_model_ids = models_probe("http://127.0.0.1:8327", smart_key)
direct_chat = chat_probe("http://127.0.0.1:8317", direct_key, direct_model_ids)
smart_chat = chat_probe("http://127.0.0.1:8327", smart_key, smart_model_ids)
services = {name: service_status(name) for name in ("cliproxy", "cpa-smart-router")}
ports = {"8317": port_open(8317), "8327": port_open(8327)}
disk = shutil.disk_usage("/")
memory_available_kb = None
with open("/proc/meminfo", encoding="utf-8") as meminfo:
    for line in meminfo:
        if line.startswith("MemAvailable:"):
            memory_available_kb = int(line.split()[1])
            break
probes = {
    "directModels": direct_models,
    "smartModels": smart_models,
    "directChat": direct_chat,
    "smartChat": smart_chat,
}
payload = {
    "ok": all(item["active"] == "active" for item in services.values()) and all(ports.values()) and all(item["ok"] for item in probes.values()),
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "hostname": socket.gethostname(),
    "services": services,
    "ports": ports,
    "probes": probes,
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
  restart-cliproxy)
    systemctl restart cliproxy.service
    sleep 5
    inspect
    ;;
  restart-router)
    systemctl restart cpa-smart-router.service
    sleep 5
    inspect
    ;;
  *)
    printf '{"ok":false,"error":"action_not_allowed"}\n'
    exit 64
    ;;
esac
CONTROL
chmod 0755 /usr/local/sbin/aiops-cpa-jp-control
chown root:root /usr/local/sbin/aiops-cpa-jp-control

cat > /usr/local/bin/aiops-cpa-jp-dispatch <<'DISPATCH'
#!/usr/bin/env bash
set -euo pipefail
case "${SSH_ORIGINAL_COMMAND:-}" in
  inspect|restart-cliproxy|restart-router)
    exec sudo -n /usr/local/sbin/aiops-cpa-jp-control "$SSH_ORIGINAL_COMMAND"
    ;;
  *)
    printf '{"ok":false,"error":"command_not_allowed"}\n'
    exit 64
    ;;
esac
DISPATCH
chmod 0755 /usr/local/bin/aiops-cpa-jp-dispatch
chown root:root /usr/local/bin/aiops-cpa-jp-dispatch

cat > /etc/sudoers.d/aiops-cpa-jp <<'SUDOERS'
Defaults:aiops !requiretty
aiops ALL=(root) NOPASSWD: /usr/local/sbin/aiops-cpa-jp-control inspect, /usr/local/sbin/aiops-cpa-jp-control restart-cliproxy, /usr/local/sbin/aiops-cpa-jp-control restart-router
SUDOERS
chmod 0440 /etc/sudoers.d/aiops-cpa-jp
visudo -cf /etc/sudoers.d/aiops-cpa-jp >/dev/null

printf 'restrict,command="/usr/local/bin/aiops-cpa-jp-dispatch" %s\n' "$PUBLIC_KEY" > /home/aiops/.ssh/authorized_keys
chown aiops:aiops /home/aiops/.ssh/authorized_keys
chmod 0600 /home/aiops/.ssh/authorized_keys
REMOTE

SSH_COMMAND=(
  ssh -F /dev/null -i "$KEY_PATH" -o BatchMode=yes
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS_PATH"
  -p "$PRODUCTION_PORT" "aiops@$PRODUCTION_HOST"
)

ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} inspect" | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["services"]["cliproxy"]["active"]=="active"; assert data["services"]["cpa-smart-router"]["active"]=="active"; assert all(data["ports"].values()); assert data["probes"]["directModels"]["ok"] is True; assert data["probes"]["smartModels"]["ok"] is True; print("cpa maintenance channel ok; business probes recorded separately")'
if ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} id" >/dev/null 2>&1; then
  printf 'restricted key unexpectedly accepted arbitrary command\n' >&2
  exit 1
fi
printf 'cpa jp maintenance channel installed\n'
