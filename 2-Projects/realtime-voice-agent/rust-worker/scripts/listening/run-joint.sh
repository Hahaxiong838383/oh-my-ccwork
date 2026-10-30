#!/bin/sh
# Linux, existing Cargo dependencies + Node >=22.13; never installs or deploys anything.
set -eu
: "${P003_LISTENING_JOINT_BUNDLE:?Set to the read-only Brain fixture bundle built by build-joint.mjs}"
task_tmp=$(mktemp -d /tmp/p003-listening-joint.XXXXXX)
node "$P003_LISTENING_JOINT_BUNDLE" "$task_tmp/config.json" >"$task_tmp/server.txt" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT INT TERM
tries=0
while [ ! -s "$task_tmp/config.json" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ] || ! kill -0 "$server_pid" 2>/dev/null; then cat "$task_tmp/server.txt"; exit 1; fi
  sleep 0.05
done
P003_LISTENING_JOINT_CONFIG="$task_tmp/config.json" cargo test --offline --locked listening_joint_real -- --ignored
