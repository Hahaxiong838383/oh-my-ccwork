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

EFFECTIVE="$TMP_DIR/effective-result.m3u"
python3 - "$CANDIDATE" "$PUBLISHED" "$EFFECTIVE" "$TMP_DIR/merge.json" <<'PY'
from pathlib import Path
import json, re, sys
candidate, published, output, report = map(Path, sys.argv[1:])
overseas_groups = {"海外新闻", "海外纪录", "港澳台"}

def block_name(block):
    ext = next((line for line in block if line.startswith("#EXTINF")), "")
    return ext.rsplit(",", 1)[-1].strip() if "," in ext else ""

def block_group(block):
    ext = next((line for line in block if line.startswith("#EXTINF")), "")
    match = re.search(r'group-title="([^"]*)"', ext)
    return match.group(1) if match else ""

def block_url(block):
    for line in block:
        line = line.strip()
        if line.startswith(("http://", "https://")):
            return line
    return ""

def parse(path):
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines() if path.exists() else []
    header = lines[0] if lines and lines[0].startswith("#EXTM3U") else "#EXTM3U"
    blocks, current = [], []
    for line in lines[1:]:
        if line.startswith("#EXTINF"):
            if current:
                blocks.append(current)
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append(current)
    return header, blocks

base_header, base_blocks = parse(published if published.exists() and published.stat().st_size else candidate)
_, candidate_blocks = parse(candidate)
merged = list(base_blocks)
seen_names = {block_name(block) for block in merged if block_name(block)}
added = []
for block in candidate_blocks:
    name = block_name(block)
    group = block_group(block)
    url = block_url(block)
    if group not in overseas_groups or not name or not url:
        continue
    if "[Geo-blocked]" in name or name in seen_names:
        continue
    merged.append(block)
    seen_names.add(name)
    added.append(name)
with output.open("w", encoding="utf-8") as handle:
    handle.write(base_header.rstrip() + "\n")
    for block in merged:
        for line in block:
            handle.write(line.rstrip() + "\n")
Path(report).write_text(json.dumps({"overseasAdded": added, "overseasAddedCount": len(added), "baseBlockCount": len(base_blocks), "candidateBlockCount": len(candidate_blocks)}, ensure_ascii=False), encoding="utf-8")
PY

meta=$(python3 - "$EFFECTIVE" "$PUBLISHED" "$TMP_DIR/entries.json" "$TMP_DIR/merge.json" <<'PY'
from pathlib import Path
import json, re, sys
source = Path(sys.argv[1])
published = Path(sys.argv[2])
entries_path = Path(sys.argv[3])
merge = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
lines = source.read_text(encoding="utf-8", errors="replace").splitlines()
if not lines or not lines[0].startswith("#EXTM3U"):
    raise SystemExit("invalid_header")
entries = []
current = None
for line in lines[1:]:
    if line.startswith("#EXTINF"):
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', line))
        current = {"name": line.rsplit(",", 1)[-1].strip(), "group": attrs.get("group-title", ""), "url": ""}
    elif current and line.strip().startswith(("http://", "https://")):
        current["url"] = line.strip()
        if not (current["name"].startswith("20") and ":" in current["name"]):
            entries.append(current)
        current = None
names = [item["name"] for item in entries]
required = {"CCTV-1", "CCTV-5", "CCTV-13", "广东卫视", "河南卫视"}
over_groups = {"海外新闻", "海外纪录", "港澳台"}
over_entries = [item for item in entries if item["group"] in over_groups]
if len(entries) < 20:
    raise SystemExit("too_few_channels")
if len(names) != len(set(names)):
    raise SystemExit("duplicate_channels")
if not required.issubset(set(names)):
    raise SystemExit("required_channels_missing")
if len(over_entries) < 8:
    raise SystemExit("too_few_overseas")
if any("[Geo-blocked]" in item["name"] for item in entries):
    raise SystemExit("geo_blocked_leaked")
entries_path.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
print(len(entries))
PY
) || { write_failure_health metadata_failed; exit 1; }

sample_json=$(python3 - "$TMP_DIR/entries.json" <<'PY'
import json, subprocess, sys
entries = {item["name"]: item["url"] for item in json.load(open(sys.argv[1], encoding="utf-8"))}
domestic_sample = ["CCTV-1", "CCTV-5", "CCTV-13", "广东卫视", "河南卫视", "四川卫视", "江西卫视"]
overseas_sample = ["Al Jazeera English (1080p)", "France 24 English (1080p)", "NHK World-Japan (1080p)", "CGTN (1080p)", "Arirang TV (1080p)", "TRT World (1080p) [Not 24/7]", "凤凰卫视", "RTHK TV 31"]
passed = 0
overseas_passed = 0
details = []
for name in domestic_sample + overseas_sample:
    url = entries.get(name)
    ok = False
    if url:
        try:
            result = subprocess.run([
                "docker", "exec", "iptv-api", "ffprobe", "-v", "error", "-rw_timeout", "10000000",
                "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "json", url,
            ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=15)
            ok = result.returncode == 0 and bool(json.loads(result.stdout or "{}").get("streams") or [])
        except Exception:
            ok = False
    if ok:
        passed += 1
        if name in overseas_sample:
            overseas_passed += 1
    details.append({"name": name, "ok": ok})
print(json.dumps({"passed": passed, "total": len(domestic_sample) + len(overseas_sample), "overseasPassed": overseas_passed, "overseasTotal": len(overseas_sample), "details": details}, ensure_ascii=False))
PY
)
sample_passed=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["passed"])' <<<"$sample_json")
sample_total=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' <<<"$sample_json")
overseas_passed=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["overseasPassed"])' <<<"$sample_json")
if [ "$sample_passed" -lt 13 ] || [ "$overseas_passed" -lt 6 ]; then
  write_failure_health sample_failed
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
install -m 0644 "$EFFECTIVE" "$TMP_DIR/result.m3u"
mv -f "$TMP_DIR/result.m3u" "$PUBLISHED"
cp -a "$PUBLISHED" "$ROOT/backups/result-$stamp.m3u"
find "$ROOT/backups" -maxdepth 1 -type f -name 'result-*.m3u' -printf '%T@ %p\n' | sort -nr | awk 'NR>7 {sub(/^[^ ]+ /,""); print}' | xargs -r rm -f
write_health true published "$meta" "$sample_passed" "$sample_total"
rm -f /var/lib/iptv-aiops/update-failure.json
printf 'IPTV_PUBLISH_OK channels=%s sample=%s/%s overseas_sample=%s/7 merge=%s\n' "$meta" "$sample_passed" "$sample_total" "$overseas_passed" "$(cat "$TMP_DIR/merge.json")"
