#!/usr/bin/env bash
set -euo pipefail

readonly AEGIS_CPU_MAX="20000 100000"
readonly AEGIS_MEMORY_HIGH="134217728"
readonly LOG_FILE="/var/log/cpa-resource-guard.log"

apply_io_priority() {
  local group_path="$1"
  local pid

  [[ -d "$group_path" ]] || return 0
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    ionice -c 3 -p "$pid"
    renice 10 -p "$pid" >/dev/null
  done < "$group_path/cgroup.procs"
}


apply_limits() {
  local group_path="$1"
  local memory_high="$2"

  [[ -d "$group_path" ]] || return 0
  printf '%s\n' "$AEGIS_CPU_MAX" > "$group_path/cpu.max"
  printf '%s\n' "$memory_high" > "$group_path/memory.high"
}

apply_limits /sys/fs/cgroup/aegis "$AEGIS_MEMORY_HIGH"
apply_limits /sys/fs/cgroup/aegisMonitor "$AEGIS_MEMORY_HIGH"
apply_io_priority /sys/fs/cgroup/aegis
apply_io_priority /sys/fs/cgroup/aegisMonitor

io_pressure="$(awk -F'[ =]' '/^some / {print $3}' /proc/pressure/io)"
memory_available_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"

if awk -v pressure="$io_pressure" -v available="$memory_available_kb" \
  'BEGIN { exit !((pressure + 0) >= 20 || (available + 0) < 153600) }'; then
  {
    printf '\n=== %s io_avg10=%s mem_available_kb=%s ===\n' \
      "$(date --iso-8601=seconds)" "$io_pressure" "$memory_available_kb"
    cat /proc/pressure/io /proc/pressure/memory
    vmstat 1 2
    timeout 5 pidstat -d -u -p ALL 1 2 || true
  } >> "$LOG_FILE" 2>&1
fi
