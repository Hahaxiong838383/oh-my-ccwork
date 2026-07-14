#!/usr/bin/env bash
set -euo pipefail

RACKNERD_ALIAS="${RACKNERD_ALIAS:-racknerd}"
PRODUCTION_ALIAS="${PRODUCTION_ALIAS:-aliyun-kr}"
PRODUCTION_HOST="${PRODUCTION_HOST:-8.213.134.133}"
PRODUCTION_PORT="${PRODUCTION_PORT:-52022}"
REMOTE_ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
SECRET_DIR="$REMOTE_ROOT/secrets/chenchuan-maintenance"
KEY_PATH="$SECRET_DIR/id_ed25519"
KNOWN_HOSTS_PATH="$SECRET_DIR/known_hosts"
TEMP_DIR="$(mktemp -d /tmp/aiops-maintenance.XXXXXX)"
trap 'rm -rf "$TEMP_DIR"' EXIT

ssh "$RACKNERD_ALIAS" "install -d -m 700 '$SECRET_DIR'; if [ ! -f '$KEY_PATH' ]; then ssh-keygen -q -t ed25519 -N '' -C 'aiops-chenchuan-maintenance' -f '$KEY_PATH'; fi; chmod 600 '$KEY_PATH'; chmod 644 '$KEY_PATH.pub'"
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

cat > /usr/local/sbin/aiops-chenchuan-site-control <<'CONTROL'
#!/usr/bin/env bash
set -euo pipefail
export HOME=/root
export PM2_HOME=/root/.pm2
export PATH=/usr/local/bin:/usr/bin:/bin
ACTION="${1:-}"

inspect() {
  python3 - <<'PY'
import datetime
import json
import os
import pathlib
import shutil
import socket
import subprocess
import time

def read_json(path, default):
    try:
        with path.open() as handle:
            return json.load(handle)
    except Exception:
        return default

def unit_value(unit, prop):
    try:
        return subprocess.check_output(
            ["systemctl", "show", unit, "--property=" + prop, "--value"],
            universal_newlines=True,
            stderr=subprocess.DEVNULL,
        ).strip()[:160]
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

app_dir = pathlib.Path("/var/www/chenchuan-site")
raw = subprocess.check_output(
    ["/usr/local/bin/pm2", "jlist"],
    universal_newlines=True,
    stderr=subprocess.DEVNULL,
    env={**os.environ, "HOME": "/root", "PM2_HOME": "/root/.pm2"},
)
processes = json.loads(raw)
process = next((item for item in processes if item.get("name") == "chenchuan-site"), None)
if process is None:
    print(json.dumps({"ok": False, "error": "process_not_found"}))
    raise SystemExit(2)
environment = process.get("pm2_env") or {}
monitoring = process.get("monit") or {}
build_file = app_dir / ".next" / "BUILD_ID"
build_id = build_file.read_text().strip()[:80] if build_file.is_file() else None
deployed_at = None
if build_file.is_file():
    deployed_at = datetime.datetime.fromtimestamp(build_file.stat().st_mtime, datetime.timezone.utc).isoformat()
disk = shutil.disk_usage(app_dir)
started_ms = environment.get("pm_uptime") or 0
source_health = read_json(app_dir / "data" / "radar-source-health.json", {})
feed_cache = read_json(app_dir / "data" / "radar-feed-cache.json", {})
theory_state = read_json(pathlib.Path("/var/lib/theory-radar/state.json"), {})
checked_at = source_health.get("checkedAt")
radar_age = iso_age_seconds(checked_at)
aihot = source_health.get("aihot") or {}
yuweiwan = source_health.get("yuweiwan") or {}
feed_items = feed_cache.get("items") or []
endpoint_ip = None
try:
    for line in pathlib.Path("/etc/hosts").read_text().splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[1] == "aihot.virxact.com":
            endpoint_ip = fields[0]
            break
except Exception:
    pass
monitor_state = None
try:
    monitor_state = " ".join(pathlib.Path("/opt/radar-health.state").read_text().split())[:120]
except Exception:
    pass
radar_ok = bool(
    radar_age is not None
    and radar_age <= 2700
    and len(feed_items) >= 300
    and aihot.get("ok")
    and yuweiwan.get("ok")
)
publish_enabled = False
try:
    for line in pathlib.Path("/etc/theory-radar.env").read_text().splitlines():
        if line.startswith("PUBLISH="):
            publish_enabled = line.split("=", 1)[1].strip().lower() in {"1", "true", "yes", "on"}
            break
except Exception:
    pass
theory_updated_at = theory_state.get("updated_at")
theory_age = iso_age_seconds(theory_updated_at)
daily_timer = unit_value("theory-radar.timer", "ActiveState")
reconcile_timer = unit_value("theory-radar-reconcile.timer", "ActiveState")
source_state = theory_state.get("source_state") or {}
rss_state = source_state.get("rss") or {}
openalex_state = source_state.get("openalex") or {}
public_reports = sorted(app_dir.glob("data/radar/report-*.json"))
latest_public_report = public_reports[-1].name if public_reports else None
last_error = theory_state.get("last_error")
if isinstance(last_error, dict):
    last_error_type = str(last_error.get("type") or last_error.get("error") or "")[:120] or None
elif last_error:
    last_error_type = str(last_error).split(":", 1)[0][:120]
else:
    last_error_type = None
theory_ok = bool(
    publish_enabled
    and theory_state.get("status") == "ok"
    and theory_state.get("published") is True
    and (theory_state.get("paper_count") or 0) > 0
    and (theory_state.get("publish_result") or {}).get("ok") is True
    and daily_timer == "active"
    and reconcile_timer == "active"
    and latest_public_report == "report-{}.json".format(theory_state.get("run_date"))
)
payload = {
    "ok": environment.get("status") == "online" and radar_ok and theory_ok,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "hostname": socket.gethostname(),
    "process": {
        "name": "chenchuan-site",
        "status": environment.get("status"),
        "pid": process.get("pid"),
        "restartCount": environment.get("restart_time"),
        "uptimeSeconds": round(max(0, time.time() - started_ms / 1000)) if started_ms else None,
        "cpuPercent": monitoring.get("cpu"),
        "memoryMB": round((monitoring.get("memory") or 0) / 1024 / 1024, 1),
    },
    "deployment": {
        "path": str(app_dir),
        "buildId": build_id,
        "deployedAt": deployed_at,
    },
    "host": {
        "load1": round(os.getloadavg()[0], 2),
        "diskUsedPercent": round((disk.used / disk.total) * 100, 1) if disk.total else None,
        "diskFreeGB": round(disk.free / 1024 / 1024 / 1024, 2),
    },
    "radar": {
        "ok": radar_ok,
        "checkedAt": checked_at,
        "ageSeconds": radar_age,
        "feedItemCount": len(feed_items),
        "latestPublishedAt": (feed_items[0] or {}).get("publishedAt") if feed_items else None,
        "aihotOk": bool(aihot.get("ok")),
        "aihotCount": aihot.get("count"),
        "yuweiwanOk": bool(yuweiwan.get("ok")),
        "yuweiwanCount": yuweiwan.get("count"),
        "endpointIp": endpoint_ip,
        "monitorState": monitor_state,
    },
    "theoryRadar": {
        "ok": theory_ok,
        "publishEnabled": publish_enabled,
        "status": theory_state.get("status"),
        "stage": theory_state.get("stage"),
        "runDate": theory_state.get("run_date"),
        "updatedAt": theory_updated_at,
        "ageSeconds": theory_age,
        "provider": theory_state.get("provider"),
        "paperCount": theory_state.get("paper_count"),
        "published": bool(theory_state.get("published")),
        "publishOk": bool((theory_state.get("publish_result") or {}).get("ok")),
        "dailyTimer": daily_timer,
        "dailyNext": unit_value("theory-radar.timer", "NextElapseUSecRealtime"),
        "reconcileTimer": reconcile_timer,
        "reconcileNext": unit_value("theory-radar-reconcile.timer", "NextElapseUSecRealtime"),
        "serviceResult": unit_value("theory-radar.service", "Result"),
        "latestPublicReport": latest_public_report,
        "lastErrorType": last_error_type,
        "source": {
            "rssOk": bool(rss_state.get("ok")),
            "rssCount": rss_state.get("count"),
            "rssCategories": rss_state.get("verified_categories"),
            "openAlexOk": bool(openalex_state.get("ok")),
            "openAlexCount": openalex_state.get("count"),
            "uniqueCandidates": source_state.get("unique_candidates"),
        },
    },
}
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
PY
}

case "$ACTION" in
  inspect)
    inspect
    ;;
  refresh-radar)
    before="$(jq -r '.checkedAt // empty' /var/www/chenchuan-site/data/radar-source-health.json 2>/dev/null || true)"
    checked_epoch="$(date -d "$before" +%s 2>/dev/null || echo 0)"
    age=$(( $(date +%s) - checked_epoch ))
    if [[ "$checked_epoch" -eq 0 || "$age" -gt 1200 ]]; then
      /usr/local/bin/pm2 restart chenchuan-site >/dev/null
      sleep 4
      curl -fsS --max-time 30 "http://127.0.0.1:3000/radar?aiops_refresh=$(date +%s)" >/dev/null
      for _ in $(seq 1 20); do
        after="$(jq -r '.checkedAt // empty' /var/www/chenchuan-site/data/radar-source-health.json 2>/dev/null || true)"
        [[ -n "$after" && "$after" != "$before" ]] && break
        sleep 2
      done
    fi
    inspect
    ;;
  run-theory-radar)
    systemctl start theory-radar.service
    inspect
    ;;
  restart-theory-radar-timers)
    systemctl daemon-reload
    systemctl restart theory-radar.timer theory-radar-reconcile.timer
    inspect
    ;;
  restart)
    /usr/local/bin/pm2 restart chenchuan-site >/dev/null
    sleep 4
    inspect
    ;;
  *)
    printf '{"ok":false,"error":"action_not_allowed"}\n'
    exit 64
    ;;
esac
CONTROL
chmod 0755 /usr/local/sbin/aiops-chenchuan-site-control
chown root:root /usr/local/sbin/aiops-chenchuan-site-control

cat > /usr/local/bin/aiops-chenchuan-site-dispatch <<'DISPATCH'
#!/usr/bin/env bash
set -euo pipefail
case "${SSH_ORIGINAL_COMMAND:-}" in
  inspect|refresh-radar|run-theory-radar|restart-theory-radar-timers|restart)
    exec sudo -n /usr/local/sbin/aiops-chenchuan-site-control "$SSH_ORIGINAL_COMMAND"
    ;;
  *)
    printf '{"ok":false,"error":"command_not_allowed"}\n'
    exit 64
    ;;
esac
DISPATCH
chmod 0755 /usr/local/bin/aiops-chenchuan-site-dispatch
chown root:root /usr/local/bin/aiops-chenchuan-site-dispatch

cat > /etc/sudoers.d/aiops-chenchuan-site <<'SUDOERS'
Defaults:aiops !requiretty
aiops ALL=(root) NOPASSWD: /usr/local/sbin/aiops-chenchuan-site-control inspect, /usr/local/sbin/aiops-chenchuan-site-control refresh-radar, /usr/local/sbin/aiops-chenchuan-site-control run-theory-radar, /usr/local/sbin/aiops-chenchuan-site-control restart-theory-radar-timers, /usr/local/sbin/aiops-chenchuan-site-control restart
SUDOERS
chmod 0440 /etc/sudoers.d/aiops-chenchuan-site
visudo -cf /etc/sudoers.d/aiops-chenchuan-site >/dev/null

printf 'restrict,command="/usr/local/bin/aiops-chenchuan-site-dispatch" %s\n' "$PUBLIC_KEY" > /home/aiops/.ssh/authorized_keys
chown aiops:aiops /home/aiops/.ssh/authorized_keys
chmod 0600 /home/aiops/.ssh/authorized_keys
REMOTE

SSH_COMMAND=(
  ssh -F /dev/null -i "$KEY_PATH" -o BatchMode=yes
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS_PATH"
  -p "$PRODUCTION_PORT" "aiops@$PRODUCTION_HOST"
)

ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} inspect" | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["ok"] is True and data["process"]["name"]=="chenchuan-site" and data["radar"]["ok"] is True and data["theoryRadar"]["ok"] is True; print("maintenance inspect ok")'
if ssh "$RACKNERD_ALIAS" "${SSH_COMMAND[*]} id" >/dev/null 2>&1; then
  printf 'restricted key unexpectedly accepted arbitrary command\n' >&2
  exit 1
fi
printf 'chenchuan maintenance channel installed\n'
