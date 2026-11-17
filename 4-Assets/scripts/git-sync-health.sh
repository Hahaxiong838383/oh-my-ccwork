#!/usr/bin/env bash
# 多机共享仓同步体检（只读）。用法：git-sync-health.sh [--fetch]
# 输出每仓：OK / AHEAD n / BEHIND n / DIVERGED a/b / DIRTY n / NO-UPSTREAM
set -uo pipefail

# 某些宿主会注入半截 GIT_CONFIG_*（缺 KEY），会让 git 直接报错；这里清干净
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 2>/dev/null || true

FETCH=0
[[ "${1:-}" == "--fetch" ]] && FETCH=1
REPOS=("$HOME/mycc" "$HOME/MyAgent" "$HOME/home-lan")
rc=0

for repo in "${REPOS[@]}"; do
  [[ -d "$repo/.git" ]] || continue
  name=$(basename "$repo")
  cd "$repo" || continue
  if [[ $FETCH -eq 1 ]]; then git fetch --quiet origin 2>/dev/null || true; fi

  dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
  if [[ -z "$up" ]]; then
    if [[ -z "$(git remote 2>/dev/null)" ]]; then
      echo "$name: LOCAL-ONLY (dirty=$dirty)"
    else
      echo "$name: NO-UPSTREAM (dirty=$dirty)"
    fi
    continue
  fi
  counts=$(git rev-list --left-right --count "$up...HEAD" 2>/dev/null)
  behind=$(echo "$counts" | awk '{print $1}')
  ahead=$(echo "$counts" | awk '{print $2}')
  if [[ "$ahead" -eq 0 && "$behind" -eq 0 ]]; then
    state="OK"
  elif [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    state="DIVERGED $behind/$ahead"; rc=2
  elif [[ "$ahead" -gt 0 ]]; then
    state="AHEAD $ahead"
    [[ "$ahead" -gt 3 ]] && rc=3
  else
    state="BEHIND $behind"
  fi
  echo "$name: $state (dirty=$dirty, upstream=$up)"
done

exit $rc
