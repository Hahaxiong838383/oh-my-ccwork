#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
bundled_root="${CODEX_WORKSPACE_NODE_ROOT:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node}"

if [ -d "$project_dir/node_modules/playwright" ]; then
  node_bin="${NODE_BIN:-$(command -v node)}"
  node_path="$project_dir/node_modules"
elif [ -x "$bundled_root/bin/node" ] && [ -d "$bundled_root/node_modules/playwright" ]; then
  node_bin="$bundled_root/bin/node"
  node_path="$bundled_root/node_modules"
else
  echo "Playwright 运行时不可用：请安装项目本地依赖，或设置 CODEX_WORKSPACE_NODE_ROOT。" >&2
  exit 2
fi

if [ -z "${AI_OPS_BROWSER_AUTH_FILE:-}" ]; then
  echo "AI_OPS_BROWSER_AUTH_FILE 未设置。" >&2
  exit 2
fi

capacity_target="${AI_OPS_CAPACITY_SSH_TARGET:-}"
capacity_root="${AI_OPS_CAPACITY_REMOTE_ROOT:-/opt/ai-ops-cockpit}"
capacity_check() {
  [ -z "$capacity_target" ] && return 0
  ssh "$capacity_target" "cd '$capacity_root' && scripts/validate-runtime-capacity.sh"
}

capacity_check
set +e
NODE_PATH="$node_path${NODE_PATH:+:$NODE_PATH}" "$node_bin" "$script_dir/validate-browser-acceptance.cjs"
browser_status=$?
set -e
capacity_status=0
capacity_check || capacity_status=$?
if [ "$browser_status" -ne 0 ]; then
  exit "$browser_status"
fi
exit "$capacity_status"
