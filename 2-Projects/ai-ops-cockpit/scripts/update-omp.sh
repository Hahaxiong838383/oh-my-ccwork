#!/usr/bin/env bash
set -euo pipefail

ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
CONTAINER="${AI_OPS_OMP_CONTAINER:-ops-terminal}"
PACKAGE="${AI_OPS_OMP_PACKAGE:-@oh-my-pi/pi-coding-agent}"
REGISTRY_URL="${AI_OPS_OMP_REGISTRY_URL:-https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent}"
COOLDOWN_SECONDS="${AI_OPS_OMP_COOLDOWN_SECONDS:-172800}"
CHECK_ONLY="${AI_OPS_OMP_CHECK_ONLY:-0}"
RUNTIME_DIR="$ROOT/terminal/runtime"
RELEASES_DIR="$RUNTIME_DIR/releases"
STATE_FILE="$RUNTIME_DIR/update-state.json"
LOCK_FILE=/tmp/aiops-omp-update.lock

published_at=""
integrity=""
tarball_url=""
release_age_seconds=""
candidate_sha256=""
dependency_count=""

mkdir -p "$RELEASES_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf 'OMP update already running\n'
  exit 0
fi

write_state() {
  local outcome="$1"
  local detail="$2"
  local latest_version="$3"
  local active_version="$4"
  local temp_file
  temp_file="$(mktemp "$RUNTIME_DIR/.update-state.XXXXXX")"
  jq -n \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg outcome "$outcome" \
    --arg detail "$detail" \
    --arg latestVersion "$latest_version" \
    --arg activeVersion "$active_version" \
    --arg publishedAt "$published_at" \
    --arg integrity "$integrity" \
    --arg tarballHost "$(python3 - "$tarball_url" <<'PY'
import sys
from urllib.parse import urlparse
print(urlparse(sys.argv[1]).hostname or "")
PY
)" \
    --arg candidateSha256 "$candidate_sha256" \
    --argjson cooldownSeconds "$COOLDOWN_SECONDS" \
    --argjson releaseAgeSeconds "${release_age_seconds:-null}" \
    --argjson dependencyCount "${dependency_count:-null}" \
    '{checkedAt:$checkedAt,outcome:$outcome,detail:$detail,latestVersion:$latestVersion,activeVersion:$activeVersion,publishedAt:$publishedAt,releaseAgeSeconds:$releaseAgeSeconds,cooldownSeconds:$cooldownSeconds,registryIntegrity:$integrity,tarballHost:$tarballHost,candidateSha256:$candidateSha256,dependencyCount:$dependencyCount}' > "$temp_file"
  chmod 0644 "$temp_file"
  mv "$temp_file" "$STATE_FILE"
}

active_version() {
  docker exec "$CONTAINER" /usr/local/bin/omp-aiops --version 2>/dev/null | sed -n 's#^omp/##p' | head -1
}

fail_check() {
  local detail="$1"
  local latest_version="${2:-}"
  local current
  current="$(active_version || true)"
  write_state "check_failed" "$detail" "$latest_version" "$current"
  printf 'OMP update check failed: %s\n' "$detail" >&2
  exit 1
}

if ! [[ "$COOLDOWN_SECONDS" =~ ^[0-9]+$ ]] || [ "$COOLDOWN_SECONDS" -lt 0 ]; then
  fail_check "invalid cooldown seconds"
fi

if ! registry_payload="$(curl -fsSL --max-time 20 "$REGISTRY_URL")"; then
  fail_check "registry request failed"
fi
latest_version="$(jq -r '."dist-tags".latest // empty' <<<"$registry_payload")"
if ! [[ "$latest_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  fail_check "registry returned an invalid version" "$latest_version"
fi

published_at="$(jq -r --arg version "$latest_version" '.time[$version] // empty' <<<"$registry_payload")"
integrity="$(jq -r --arg version "$latest_version" '.versions[$version].dist.integrity // empty' <<<"$registry_payload")"
tarball_url="$(jq -r --arg version "$latest_version" '.versions[$version].dist.tarball // empty' <<<"$registry_payload")"
if [ -z "$published_at" ] || ! [[ "$integrity" =~ ^sha512-[A-Za-z0-9+/]+={0,2}$ ]]; then
  fail_check "registry metadata missing publish time or sha512 integrity" "$latest_version"
fi
if ! python3 - "$tarball_url" <<'PY'
import sys
from urllib.parse import urlparse
parsed = urlparse(sys.argv[1])
raise SystemExit(0 if parsed.scheme == "https" and parsed.hostname == "registry.npmjs.org" else 1)
PY
then
  fail_check "registry tarball URL is not the expected HTTPS host" "$latest_version"
fi

published_epoch="$(python3 - "$published_at" <<'PY'
import datetime, sys
try:
    value = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
except ValueError:
    raise SystemExit(1)
print(int(value.timestamp()))
PY
)" || fail_check "registry publish time is invalid" "$latest_version"
now_epoch="$(date +%s)"
release_age_seconds="$((now_epoch - published_epoch))"
if [ "$release_age_seconds" -lt 0 ]; then
  fail_check "registry publish time is in the future" "$latest_version"
fi

current="$(active_version || true)"
if [ "$current" = "$latest_version" ]; then
  write_state "up_to_date" "no update required" "$latest_version" "$current"
  printf 'OMP already up to date: %s\n' "$current"
  exit 0
fi
if [ "$release_age_seconds" -lt "$COOLDOWN_SECONDS" ]; then
  remaining="$((COOLDOWN_SECONDS - release_age_seconds))"
  write_state "cooling" "latest release is inside the safety cooling period (${remaining}s remaining)" "$latest_version" "$current"
  printf 'OMP release %s is cooling for another %ss\n' "$latest_version" "$remaining"
  exit 0
fi

tarball_file="$(mktemp /tmp/aiops-omp-tarball.XXXXXX.tgz)"
cleanup_tarball() {
  rm -f "$tarball_file"
}
trap cleanup_tarball EXIT
if ! curl -fsSL --max-time 60 "$tarball_url" -o "$tarball_file"; then
  fail_check "candidate tarball download failed" "$latest_version"
fi
if ! python3 - "$tarball_file" "$integrity" <<'PY'
import base64, hashlib, hmac, sys
path, integrity = sys.argv[1:]
expected = base64.b64decode(integrity.split("-", 1)[1])
digest = hashlib.sha512(open(path, "rb").read()).digest()
raise SystemExit(0 if hmac.compare_digest(digest, expected) else 1)
PY
then
  fail_check "candidate tarball integrity mismatch" "$latest_version"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  write_state "eligible" "release passed cooling and registry integrity verification" "$latest_version" "$current"
  printf 'OMP release eligible: %s\n' "$latest_version"
  exit 0
fi

release_dir="$RELEASES_DIR/$latest_version"
container_release_dir="/opt/omp-runtime/releases/$latest_version"
candidate="$container_release_dir/bin/omp"
previous_target="$(readlink "$RUNTIME_DIR/current" 2>/dev/null || true)"

rm -rf "$release_dir"
mkdir -p "$release_dir"
if ! docker exec -u root \
  -e BUN_INSTALL="$container_release_dir" \
  "$CONTAINER" /opt/bun/bin/bun add -g "$PACKAGE@$latest_version" >/dev/null; then
  rm -rf "$release_dir"
  write_state "install_failed" "candidate installation failed" "$latest_version" "$current"
  exit 1
fi

if ! docker exec -u root "$CONTAINER" chown -R ops:ops /home/ops/.omp "$container_release_dir"; then
  rm -rf "$release_dir"
  write_state "candidate_failed" "candidate ownership repair failed" "$latest_version" "$current"
  exit 1
fi

if ! docker exec "$CONTAINER" "$candidate" --version | grep -qx "omp/$latest_version"; then
  rm -rf "$release_dir"
  write_state "candidate_failed" "candidate version check failed" "$latest_version" "$current"
  exit 1
fi

metadata_dir="$release_dir/metadata"
mkdir -p "$metadata_dir"
python3 - "$release_dir" "$metadata_dir/dependencies.json" <<'PY'
import json, os, sys
root, output = sys.argv[1:]
packages = []
for current, directories, files in os.walk(root):
    directories[:] = [name for name in directories if name != "metadata"]
    if "package.json" not in files:
        continue
    path = os.path.join(current, "package.json")
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        continue
    name, version = data.get("name"), data.get("version")
    if name and version:
        packages.append({"name": str(name), "version": str(version)})
packages.sort(key=lambda item: (item["name"], item["version"]))
with open(output, "w", encoding="utf-8") as file:
    json.dump({"count": len(packages), "packages": packages}, file, ensure_ascii=False, indent=2)
PY
dependency_count="$(jq -r '.count' "$metadata_dir/dependencies.json")"
candidate_sha256="$(find "$release_dir" -type f ! -path '*/metadata/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
jq -n \
  --arg package "$PACKAGE" \
  --arg version "$latest_version" \
  --arg publishedAt "$published_at" \
  --arg registryIntegrity "$integrity" \
  --arg tarballUrl "$tarball_url" \
  --arg candidateSha256 "$candidate_sha256" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson dependencyCount "$dependency_count" \
  '{package:$package,version:$version,publishedAt:$publishedAt,registryIntegrity:$registryIntegrity,tarballUrl:$tarballUrl,candidateSha256:$candidateSha256,dependencyCount:$dependencyCount,generatedAt:$generatedAt}' > "$metadata_dir/release-metadata.json"
chmod 0644 "$metadata_dir/dependencies.json" "$metadata_dir/release-metadata.json"
write_state "candidate_validating" "candidate integrity and dependency snapshot passed; running inference and regression" "$latest_version" "$current"

if ! docker exec "$CONTAINER" bash -lc \
  "HOME=/home/ops PI_CODING_AGENT_DIR=/home/ops/.omp/agent '$candidate' models find \"\$AI_OPS_OMP_MODEL\" --json | grep -q deepseek-v4-pro"; then
  rm -rf "$release_dir"
  write_state "candidate_failed" "configured model was not discovered" "$latest_version" "$current"
  exit 1
fi

smoke_output="$(docker exec "$CONTAINER" bash -lc \
  "HOME=/home/ops PI_CODING_AGENT_DIR=/home/ops/.omp/brain-agent timeout 180 '$candidate' --model \"\$AI_OPS_OMP_MODEL\" --cwd /workspace/brain --no-tools --no-session --no-rules --no-skills --no-extensions --no-lsp --no-pty --no-prewalk --no-title -p '只回复：OMP_AUTO_UPDATE_OK'" 2>&1 || true)"
if ! grep -q 'OMP_AUTO_UPDATE_OK' <<<"$smoke_output"; then
  rm -rf "$release_dir"
  write_state "candidate_failed" "candidate inference smoke test failed" "$latest_version" "$current"
  exit 1
fi

next_link="$RUNTIME_DIR/.current.$$"
ln -s "releases/$latest_version" "$next_link"
mv -Tf "$next_link" "$RUNTIME_DIR/current"

rollback() {
  if [ -n "$previous_target" ]; then
    next_link="$RUNTIME_DIR/.rollback.$$"
    ln -s "$previous_target" "$next_link"
    mv -Tf "$next_link" "$RUNTIME_DIR/current"
  else
    rm -f "$RUNTIME_DIR/current"
  fi
  write_state "rolled_back" "post-promotion regression failed" "$latest_version" "$(active_version || true)"
}

if ! AI_OPS_REGRESSION_SLEEP="${AI_OPS_REGRESSION_SLEEP:-22}" "$ROOT/scripts/validate-vibe-regression.sh" >/tmp/aiops-omp-update-regression.log 2>&1; then
  rollback
  exit 1
fi

active="$(active_version || true)"
if [ "$active" != "$latest_version" ]; then
  rollback
  exit 1
fi

write_state "updated" "candidate integrity, inference and full regression passed" "$latest_version" "$active"

current_real="$(readlink -f "$RUNTIME_DIR/current" 2>/dev/null || true)"
mapfile -t old_releases < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>3 {$1=""; sub(/^ /,""); print}')
for old_release in "${old_releases[@]:-}"; do
  [ -n "$old_release" ] || continue
  [ "$(readlink -f "$old_release")" = "$current_real" ] && continue
  rm -rf "$old_release"
done

printf 'OMP updated: %s -> %s\n' "${current:-fallback}" "$active"
