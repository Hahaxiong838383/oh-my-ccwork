#!/usr/bin/env bash
set -u

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_dir="$deploy_dir/runtime"
pid_file="$runtime_dir/public-tunnel-supervisor.pid"
log_file="$runtime_dir/public-tunnel.log"
lock_file="$runtime_dir/public-tunnel.lock"

mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"

exec 9>"$lock_file"
if ! flock -n 9; then
  exit 0
fi

printf '%s\n' "$$" >"$pid_file"
chmod 600 "$pid_file"
cleanup() {
  if [[ -e "$pid_file" ]]; then
    unlink "$pid_file"
  fi
}
trap cleanup EXIT INT TERM

while true; do
  if [[ -f "$log_file" ]] && (( $(wc -c <"$log_file") > 1048576 )); then
    mv "$log_file" "$log_file.1"
  fi
  printf '%s tunnel start\n' "$(date --iso-8601=seconds)" >>"$log_file"
  "$deploy_dir/public-tunnel.sh" >>"$log_file" 2>&1
  exit_code=$?
  printf '%s tunnel exit=%s; retry in 5s\n' \
    "$(date --iso-8601=seconds)" "$exit_code" >>"$log_file"
  sleep 5
done
