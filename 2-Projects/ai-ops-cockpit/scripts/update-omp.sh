#!/usr/bin/env bash
set -euo pipefail

ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
CONTAINER="${AI_OPS_OMP_CONTAINER:-ops-terminal}"
PACKAGE="${AI_OPS_OMP_PACKAGE:-@oh-my-pi/pi-coding-agent}"
REGISTRY_URL="${AI_OPS_OMP_REGISTRY_URL:-https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest}"
RUNTIME_DIR="$ROOT/terminal/runtime"
RELEASES_DIR="$RUNTIME_DIR/releases"
STATE_FILE="$RUNTIME_DIR/update-state.json"
LOCK_FILE=/tmp/aiops-omp-update.lock

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
    '{checkedAt:$checkedAt,outcome:$outcome,detail:$detail,latestVersion:$latestVersion,activeVersion:$activeVersion}' > "$temp_file"
  chmod 0644 "$temp_file"
  mv "$temp_file" "$STATE_FILE"
}

active_version() {
  docker exec "$CONTAINER" /usr/local/bin/omp-aiops --version 2>/dev/null | sed -n 's#^omp/##p' | head -1
}

if ! registry_payload="$(curl -fsSL --max-time 20 "$REGISTRY_URL")"; then
  current="$(active_version || true)"
  write_state "check_failed" "registry request failed" "" "$current"
  exit 1
fi
latest_version="$(jq -r '.version // empty' <<<"$registry_payload")"
if ! [[ "$latest_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  current="$(active_version || true)"
  write_state "check_failed" "registry returned an invalid version" "$latest_version" "$current"
  exit 1
fi

current="$(active_version || true)"
if [ "$current" = "$latest_version" ]; then
  write_state "up_to_date" "no update required" "$latest_version" "$current"
  printf 'OMP already up to date: %s\n' "$current"
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

if ! docker exec "$CONTAINER" bash -lc \
  "HOME=/home/ops PI_CODING_AGENT_DIR=/home/ops/.omp/agent '$candidate' models find \"\$AI_OPS_OMP_MODEL\" --json | grep -q deepseek-v4-pro"; then
  rm -rf "$release_dir"
  write_state "candidate_failed" "configured model was not discovered" "$latest_version" "$current"
  exit 1
fi

smoke_output="$(docker exec "$CONTAINER" bash -lc \
  "HOME=/home/ops PI_CODING_AGENT_DIR=/home/ops/.omp/agent timeout 180 '$candidate' --model \"\$AI_OPS_OMP_MODEL\" --cwd /workspace/projects/ai-ops-cockpit --no-tools --no-session -p '只回复：OMP_AUTO_UPDATE_OK'" 2>&1 || true)"
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

write_state "updated" "candidate and full regression passed" "$latest_version" "$active"

current_real="$(readlink -f "$RUNTIME_DIR/current" 2>/dev/null || true)"
mapfile -t old_releases < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>3 {$1=""; sub(/^ /,""); print}')
for old_release in "${old_releases[@]:-}"; do
  [ -n "$old_release" ] || continue
  [ "$(readlink -f "$old_release")" = "$current_real" ] && continue
  rm -rf "$old_release"
done

printf 'OMP updated: %s -> %s\n' "${current:-fallback}" "$active"
