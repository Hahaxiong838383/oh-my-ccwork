#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"

cat > "$temp_dir/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = inspect ]; then
  exit 0
fi
if [ "$1" = top ]; then
  echo COMMAND
  count=0
  if [ "$2" = ops-terminal ]; then count="${TEST_TERMINAL_OMP:-0}"; fi
  if [ "$2" = ops-brain ]; then count="${TEST_BRAIN_OMP:-0}"; fi
  while [ "$count" -gt 0 ]; do
    echo omp
    count=$((count - 1))
  done
  exit 0
fi
exit 2
SH
chmod +x "$temp_dir/bin/docker"

write_fixture() {
  local load="$1" available="$2"
  printf '%s 0.10 0.05 1/100 1\n' "$load" > "$temp_dir/loadavg"
  cat > "$temp_dir/meminfo" <<EOF
MemAvailable:    $available kB
SwapTotal:       1048576 kB
SwapFree:        524288 kB
EOF
}

run_check() {
  PATH="$temp_dir/bin:$PATH" \
  AI_OPS_CAPACITY_LOADAVG_FILE="$temp_dir/loadavg" \
  AI_OPS_CAPACITY_MEMINFO_FILE="$temp_dir/meminfo" \
  "$script_dir/validate-runtime-capacity.sh"
}

write_fixture 0.50 600000
TEST_TERMINAL_OMP=0 TEST_BRAIN_OMP=0 run_check | grep -q 'OK runtime capacity'

write_fixture 3.00 600000
if TEST_TERMINAL_OMP=0 TEST_BRAIN_OMP=0 run_check >/dev/null 2>&1; then
  echo 'high load should fail' >&2
  exit 1
fi

write_fixture 0.50 200000
if TEST_TERMINAL_OMP=0 TEST_BRAIN_OMP=0 run_check >/dev/null 2>&1; then
  echo 'low memory should fail' >&2
  exit 1
fi

write_fixture 0.50 600000
if TEST_TERMINAL_OMP=1 TEST_BRAIN_OMP=0 run_check >/dev/null 2>&1; then
  echo 'active OMP should fail' >&2
  exit 1
fi

echo 'OK runtime capacity tests'
