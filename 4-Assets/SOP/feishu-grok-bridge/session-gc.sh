#!/usr/bin/env bash
# Archive oversized Grok sessions + write into Grok memory system for recall.
# Not idle-timeout based — only size (and optional age for orphans).
set -euo pipefail

GROK_HOME="${GROK_HOME:-$HOME/.grok}"
SESSIONS="$GROK_HOME/sessions"
ARCHIVE="$GROK_HOME/sessions-archive"
MAX_BYTES="${GROK_SESSION_MAX_BYTES:-20971520}"   # 20MB
ORPHAN_DAYS="${GROK_SESSION_ORPHAN_DAYS:-14}"
LOG="${GROK_HOME}/logs/session-gc.log"
# bridge repo path (dev198 default)
BRIDGE_ROOT="${FEISHU_GROK_BRIDGE_ROOT:-$HOME/feishu-grok-bridge}"
NODE_BIN="${NODE_BIN:-$HOME/.local/node/bin/node}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
MEM_SCRIPT="${BRIDGE_ROOT}/archive-to-memory.mjs"

mkdir -p "$ARCHIVE" "$(dirname "$LOG")"
ts() { date -Iseconds; }

record_memory() {
  local dir="$1" reason="$2" bytes="${3:-0}"
  if [[ -z "${NODE_BIN:-}" || ! -f "$MEM_SCRIPT" ]]; then
    echo "[$(ts)] skip memory: node/script missing"
    return 0
  fi
  "$NODE_BIN" "$MEM_SCRIPT" --dir "$dir" --reason "$reason" --size "$bytes" 2>&1 \
    | while IFS= read -r line; do echo "[$(ts)] memory $line"; done || true
}

{
  echo "[$(ts)] session-gc start max=${MAX_BYTES} orphan_days=${ORPHAN_DAYS}"
  if [[ ! -d "$SESSIONS" ]]; then
    echo "[$(ts)] no sessions dir"
    exit 0
  fi

  # 1) size: any session dir >= MAX_BYTES
  while IFS= read -r -d '' dir; do
    sid=$(basename "$dir")
    bytes=$(du -sb "$dir" 2>/dev/null | awk '{print $1}')
    if [[ -n "${bytes:-}" && "$bytes" -ge "$MAX_BYTES" ]]; then
      dest="$ARCHIVE/${sid}.$(date +%Y%m%d%H%M%S)"
      mv "$dir" "$dest"
      echo "[$(ts)] archived size bytes=${bytes} -> $(basename "$dest")"
      record_memory "$dest" "gc_size" "$bytes"
    fi
  done < <(find "$SESSIONS" -mindepth 2 -maxdepth 2 -type d -print0 2>/dev/null)

  # 2) age: orphan session dirs not modified in ORPHAN_DAYS
  if [[ "${ORPHAN_DAYS}" -gt 0 ]]; then
    while IFS= read -r -d '' dir; do
      sid=$(basename "$dir")
      bytes=$(du -sb "$dir" 2>/dev/null | awk '{print $1}')
      dest="$ARCHIVE/${sid}.age.$(date +%Y%m%d%H%M%S)"
      mv "$dir" "$dest"
      echo "[$(ts)] archived age -> $(basename "$dest")"
      record_memory "$dest" "gc_age" "${bytes:-0}"
    done < <(find "$SESSIONS" -mindepth 2 -maxdepth 2 -type d -mtime "+${ORPHAN_DAYS}" -print0 2>/dev/null)
  fi

  echo "[$(ts)] session-gc done"
} >>"$LOG" 2>&1
