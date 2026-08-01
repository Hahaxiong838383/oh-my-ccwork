#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/update-omp.sh"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
mkdir -p "$TEMP_DIR/bin" "$TEMP_DIR/root/terminal/runtime/releases"

cat > "$TEMP_DIR/bin/flock" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$TEMP_DIR/bin/flock"

python3 - "$TEMP_DIR/tarball.tgz" <<'PY'
import sys
open(sys.argv[1], "wb").write(b"verified omp fixture")
PY
INTEGRITY="$(python3 - "$TEMP_DIR/tarball.tgz" <<'PY'
import base64, hashlib, sys
print("sha512-" + base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())
PY
)"
OLD_TIME="$(python3 - <<'PY'
import datetime
print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=3)).isoformat().replace('+00:00','Z'))
PY
)"
NEW_TIME="$(python3 - <<'PY'
import datetime
print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'))
PY
)"

cat > "$TEMP_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  printf 'omp/%s\n' "${FAKE_ACTIVE_VERSION:-1.0.0}"
  exit 0
fi
printf 'unexpected docker call: %s\n' "$*" >&2
exit 99
SH
chmod +x "$TEMP_DIR/bin/docker"

cat > "$TEMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ -n "$output" ]; then
  cp "$FAKE_TARBALL" "$output"
else
  cat "$FAKE_METADATA"
fi
SH
chmod +x "$TEMP_DIR/bin/curl"

write_metadata() {
  local published_at="$1"
  local integrity="$2"
  cat > "$TEMP_DIR/metadata.json" <<JSON
{"dist-tags":{"latest":"2.0.0"},"time":{"2.0.0":"$published_at"},"versions":{"2.0.0":{"dist":{"integrity":"$integrity","tarball":"https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-2.0.0.tgz"}}}}
JSON
}

run_check() {
  PATH="$TEMP_DIR/bin:$PATH" \
  FAKE_ACTIVE_VERSION=1.0.0 \
  FAKE_TARBALL="$TEMP_DIR/tarball.tgz" \
  FAKE_METADATA="$TEMP_DIR/metadata.json" \
  AI_OPS_ROOT="$TEMP_DIR/root" \
  AI_OPS_OMP_CHECK_ONLY=1 \
  "$SCRIPT"
}

write_metadata "$NEW_TIME" "$INTEGRITY"
run_check | grep -q 'is cooling'
jq -e '.outcome=="cooling" and .releaseAgeSeconds>=0 and .cooldownSeconds==172800 and (.registryIntegrity|startswith("sha512-"))' "$TEMP_DIR/root/terminal/runtime/update-state.json" >/dev/null

write_metadata "$OLD_TIME" "$INTEGRITY"
run_check | grep -q 'release eligible'
jq -e '.outcome=="eligible" and .tarballHost=="registry.npmjs.org" and .releaseAgeSeconds>=172800' "$TEMP_DIR/root/terminal/runtime/update-state.json" >/dev/null

write_metadata "$OLD_TIME" 'sha512-invalid'
if run_check >/tmp/aiops-update-invalid.log 2>&1; then
  printf 'invalid integrity unexpectedly passed\n' >&2
  exit 1
fi
jq -e '.outcome=="check_failed"' "$TEMP_DIR/root/terminal/runtime/update-state.json" >/dev/null

printf 'OK update-omp supply-chain tests\n'
