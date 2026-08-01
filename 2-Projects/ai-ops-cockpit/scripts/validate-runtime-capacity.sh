#!/usr/bin/env bash
set -euo pipefail

max_load_1m="${AI_OPS_CAPACITY_MAX_LOAD_1M:-2.50}"
min_available_kb="${AI_OPS_CAPACITY_MIN_AVAILABLE_KB:-307200}"
max_active_omp="${AI_OPS_CAPACITY_MAX_ACTIVE_OMP:-0}"
loadavg_file="${AI_OPS_CAPACITY_LOADAVG_FILE:-/proc/loadavg}"
meminfo_file="${AI_OPS_CAPACITY_MEMINFO_FILE:-/proc/meminfo}"

load_1m=$(awk '{print $1}' "$loadavg_file")
available_kb=$(awk '/MemAvailable:/ {print $2}' "$meminfo_file")
swap_total_kb=$(awk '/SwapTotal:/ {print $2}' "$meminfo_file")
swap_free_kb=$(awk '/SwapFree:/ {print $2}' "$meminfo_file")
swap_used_kb=$((swap_total_kb - swap_free_kb))

container_omp_count() {
  local container="$1"
  if ! docker inspect "$container" >/dev/null 2>&1; then
    printf '%s' 0
    return
  fi
  docker top "$container" -eo comm 2>/dev/null | tail -n +2 | grep -c '^omp$' || true
}

terminal_omp=$(container_omp_count ops-terminal)
brain_omp=$(container_omp_count ops-brain)
active_omp=$((terminal_omp + brain_omp))

printf 'capacity load1=%s available_kb=%s swap_used_kb=%s terminal_omp=%s brain_omp=%s\n' \
  "$load_1m" "$available_kb" "$swap_used_kb" "$terminal_omp" "$brain_omp"

awk -v value="$load_1m" -v limit="$max_load_1m" 'BEGIN { exit !(value <= limit) }' || {
  printf 'capacity blocked: load1 %s exceeds %s\n' "$load_1m" "$max_load_1m" >&2
  exit 1
}
if [ "$available_kb" -lt "$min_available_kb" ]; then
  printf 'capacity blocked: MemAvailable %s KiB is below %s KiB\n' "$available_kb" "$min_available_kb" >&2
  exit 1
fi
if [ "$active_omp" -gt "$max_active_omp" ]; then
  printf 'capacity blocked: active OMP %s exceeds %s\n' "$active_omp" "$max_active_omp" >&2
  exit 1
fi

printf 'OK runtime capacity\n'
