#!/usr/bin/env bash
set -euo pipefail
ROOT="${IPTV_ROOT:-/opt/stacks/iptv-api}"
CANDIDATE="$ROOT/output/ipv4/result.m3u"
PUBLISHED="$ROOT/published/result.m3u"
HEALTH=/var/lib/iptv-aiops/health.json
TMP_DIR="$(mktemp -d /tmp/iptv-validate.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

write_health() {
  local ok="$1" status="$2" channel_count="$3" sample_passed="$4" sample_total="$5"
  python3 - "$HEALTH" "$ok" "$status" "$channel_count" "$sample_passed" "$sample_total" <<'PY'
import datetime, json, os, sys, tempfile
path, ok, status, channels, passed, total = sys.argv[1:]
payload = {
    "ok": ok == "true",
    "status": status,
    "channelCount": int(channels),
    "samplePassed": int(passed),
    "sampleTotal": int(total),
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "scope": "server_readiness_not_full_business_health",
}
os.makedirs(os.path.dirname(path), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".health-", text=True)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

write_failure_health() {
  local status="$1"
  if [ -s "$PUBLISHED" ]; then
    python3 - "/var/lib/iptv-aiops/update-failure.json" "$status" <<'PY'
import datetime, json, os, sys, tempfile
path, status = sys.argv[1:]
payload = {
    "ok": False,
    "status": status,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "publishedPreserved": True,
}
os.makedirs(os.path.dirname(path), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".failure-", text=True)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
    return
  fi
  write_health false "$status" 0 0 0
}

if [ ! -s "$CANDIDATE" ]; then
  write_failure_health candidate_missing
  exit 1
fi

meta=$(python3 - "$CANDIDATE" "$TMP_DIR/entries.json" <<'PY'
from pathlib import Path
import json, sys
source = Path(sys.argv[1])
lines = source.read_text(encoding="utf-8", errors="replace").splitlines()
if not lines or not lines[0].startswith("#EXTM3U"):
    raise SystemExit("invalid_header")
entries = []
for index, line in enumerate(lines[:-1]):
    if not line.startswith("#EXTINF"):
        continue
    name = line.rsplit(",", 1)[-1].strip()
    url = lines[index + 1].strip()
    if name.startswith("20") and ":" in name:
        continue
    if url.startswith(("http://", "https://")):
        entries.append({"name": name, "url": url})
names = [item["name"] for item in entries]
required = {"CCTV-1", "CCTV-5", "CCTV-13", "广东卫视", "河南卫视"}
if len(entries) < 20:
    raise SystemExit("too_few_channels")
if len(names) != len(set(names)):
    raise SystemExit("duplicate_channels")
if not required.issubset(set(names)):
    raise SystemExit("required_channels_missing")
Path(sys.argv[2]).write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
print(len(entries))
PY
) || { write_failure_health metadata_failed; exit 1; }

sample_passed=$(python3 - "$TMP_DIR/entries.json" <<'PY'
import json, subprocess, sys
entries = {item["name"]: item["url"] for item in json.load(open(sys.argv[1], encoding="utf-8"))}
sample = ["CCTV-1", "CCTV-5", "CCTV-13", "广东卫视", "河南卫视", "四川卫视", "江西卫视"]
passed = 0
for name in sample:
    url = entries.get(name)
    if not url:
        continue
    try:
        result = subprocess.run([
            "docker", "exec", "iptv-api", "ffprobe", "-v", "error", "-rw_timeout", "10000000",
            "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "json", url,
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=15)
        if result.returncode == 0 and (json.loads(result.stdout or "{}").get("streams") or []):
            passed += 1
    except Exception:
        pass
print(passed)
PY
)
sample_total=7
if [ "$sample_passed" -lt 5 ]; then
  write_failure_health sample_failed
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
install -m 0644 "$CANDIDATE" "$TMP_DIR/result.m3u"
mv -f "$TMP_DIR/result.m3u" "$PUBLISHED"
cp -a "$PUBLISHED" "$ROOT/backups/result-$stamp.m3u"
find "$ROOT/backups" -maxdepth 1 -type f -name 'result-*.m3u' -printf '%T@ %p\n' | sort -nr | awk 'NR>7 {sub(/^[^ ]+ /,""); print}' | xargs -r rm -f
write_health true published "$meta" "$sample_passed" "$sample_total"
rm -f /var/lib/iptv-aiops/update-failure.json
printf 'IPTV_PUBLISH_OK channels=%s sample=%s/%s\n' "$meta" "$sample_passed" "$sample_total"
