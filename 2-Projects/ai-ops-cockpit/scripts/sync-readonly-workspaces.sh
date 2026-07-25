#!/usr/bin/env bash
set -euo pipefail

ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
SRC_ROOT="${AI_OPS_READONLY_SRC:-/opt/ai-ops-workspaces}"
DEST_ROOT="$ROOT/readonly"
mkdir -p "$SRC_ROOT" "$DEST_ROOT"

RSYNC_EXCLUDES=(
  --exclude '.git' --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' --exclude 'id_rsa*'
  --exclude '*.p12' --exclude '*.pfx' --exclude '*.mobileprovision' --exclude '*.sqlite' --exclude '*.db'
  --exclude '.npmrc' --exclude '.pypirc' --exclude '.netrc' --exclude '*secret*' --exclude '*credential*' --exclude 'service-account*.json'
  --exclude 'node_modules' --exclude '.venv' --exclude 'venv' --exclude '__pycache__'
  --exclude '.DS_Store' --exclude 'dist' --exclude 'build' --exclude '.next'
)

secret_scan_dir() {
  local target="$1"
  local pattern
  pattern="(sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|refresh[_-]?token[\"' :=]{1,8}[A-Za-z0-9._-]{20,}|access[_-]?token[\"' :=]{1,8}[A-Za-z0-9._-]{20,}|api[_-]?key[\"' :=]{1,8}[A-Za-z0-9._-]{20,}|password[\"' :=]{1,8}[^[:space:]]{10,}|https://open.feishu.cn/open-apis/bot/v2/hook/[A-Za-z0-9-]{20,})"
  if command -v rg >/dev/null 2>&1; then
    if rg -l -i "$pattern" "$target" >/tmp/aiops-readonly-secret-scan.txt 2>/dev/null; then
      echo "secret-like content detected in readonly snapshot: $target" >&2
      cat /tmp/aiops-readonly-secret-scan.txt >&2
      return 1
    fi
  fi
}

make_readonly() {
  local target="$1"
  secret_scan_dir "$target"
  find "$target" -type d -exec chmod 0555 {} +
  find "$target" -type f -exec chmod 0444 {} +
}

purge_sensitive_paths() {
  local target="$1"
  find "$target" \
    \( -name '.git' -o -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' \
       -o -name '*.p12' -o -name '*.pfx' -o -name '*.mobileprovision' -o -name '*.sqlite' -o -name '*.db' \
       -o -name '.npmrc' -o -name '.pypirc' -o -name '.netrc' -o -iname '*secret*' -o -iname '*credential*' \
       -o -name 'service-account*.json' -o -name 'node_modules' -o -name '.venv' -o -name 'venv' \
       -o -name '__pycache__' -o -name 'dist' -o -name 'build' -o -name '.next' \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
}

create_project_placeholder() {
  local name="$1"
  local dest="$DEST_ROOT/$name"
  mkdir -p "$dest"
  chmod -R u+w "$dest" 2>/dev/null || true
  rm -rf "$dest"/*
  cat > "$dest/README.md" <<EOF
# $name readonly snapshot pending

No directory-level sync is enabled by default. Add an explicit file allowlist before exposing this project to Grok.
EOF
  make_readonly "$dest"
}

copy_mycc_minimal() {
  local dest="$DEST_ROOT/mycc"
  mkdir -p "$dest"
  chmod -R u+w "$dest" 2>/dev/null || true
  rm -rf "$dest"/*
  for path in \
    AGENTS.md \
    CLAUDE.md \
    README.md \
    docs/rules/SCHEMA.md \
    docs/rules/CONTEXT-BUDGET.md \
    docs/rules/FEISHU-FALLBACK.md \
    2-Projects/ai-ops-cockpit/README.md \
    2-Projects/ai-ops-cockpit/compose.yaml \
    2-Projects/ai-ops-cockpit/caddy/Caddyfile \
    2-Projects/ai-ops-cockpit/ops-inspector/server.py \
    2-Projects/ai-ops-cockpit/scripts/validate-vibe-regression.sh \
    2-Projects/ai-ops-cockpit/scripts/sync-readonly-workspaces.sh \
    2-Projects/ai-ops-cockpit/scripts/install-readonly-refresh-cron.sh \
    2-Projects/ai-ops-cockpit/scripts/install-omp-auto-update-cron.sh \
    2-Projects/ai-ops-cockpit/scripts/update-omp.sh \
    2-Projects/ai-ops-cockpit/terminal/Dockerfile \
    2-Projects/ai-ops-cockpit/terminal/omp-aiops \
    2-Projects/ai-ops-cockpit/terminal/vibe-bashrc \
    2-Projects/ai-ops-cockpit/terminal/vibe-omp \
    2-Projects/ai-ops-cockpit/terminal/vibe-shell; do
    if [ -e "$ROOT/$path" ]; then
      mkdir -p "$dest/$(dirname -- "$path")"
      cp "$ROOT/$path" "$dest/$path"
    fi
  done
  purge_sensitive_paths "$dest"
  make_readonly "$dest"
}

copy_allowlist_snapshot() {
  local name="$1"
  local source="$2"
  shift 2
  local dest="$DEST_ROOT/$name"
  if [ ! -d "$source" ]; then
    create_project_placeholder "$name"
    return
  fi
  mkdir -p "$dest"
  chmod -R u+w "$dest" 2>/dev/null || true
  rm -rf "$dest"/*
  for path in "$@"; do
    if [ -f "$source/$path" ]; then
      mkdir -p "$dest/$(dirname -- "$path")"
      cp "$source/$path" "$dest/$path"
    fi
  done
  purge_sensitive_paths "$dest"
  make_readonly "$dest"
}

copy_manifest_snapshot() {
  local name="$1"
  local source="$2"
  local manifest="$3"
  local paths=()
  local line
  if [ ! -f "$manifest" ]; then
    create_project_placeholder "$name"
    return
  fi
  while IFS= read -r line; do
    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi
    paths+=("$line")
  done < "$manifest"
  copy_allowlist_snapshot "$name" "$source" "${paths[@]}"
}

if [ -d "$ROOT/2-Projects/ai-ops-cockpit" ]; then
  copy_mycc_minimal
elif [ -f "$DEST_ROOT/mycc/AGENTS.md" ]; then
  make_readonly "$DEST_ROOT/mycc"
else
  mkdir -p "$DEST_ROOT/mycc"
  cat > "$DEST_ROOT/mycc/README.md" <<'EOF'
# mycc readonly snapshot pending

Push a sanitized snapshot from the trusted local machine.
EOF
  make_readonly "$DEST_ROOT/mycc"
fi

copy_manifest_snapshot chenchuan-site "$SRC_ROOT/chenchuan-site" "$ROOT/config/chenchuan-site-allowlist.txt"
copy_manifest_snapshot cpa-smart-router "$SRC_ROOT/cpa-smart-router" "$ROOT/config/cpa-smart-router-allowlist.txt"
copy_manifest_snapshot iptv-api "$SRC_ROOT/iptv-api" "$ROOT/config/iptv-api-allowlist.txt"
copy_manifest_snapshot realtime-voice-agent "$SRC_ROOT/realtime-voice-agent" "$ROOT/config/realtime-voice-agent-allowlist.txt"
copy_allowlist_snapshot MyJavis "$SRC_ROOT/MyJavis" \
  README.md \
  HANDOFF.md \
  package.json \
  pnpm-workspace.yaml \
  apps/server/package.json \
  apps/server/tsconfig.json \
  apps/web/package.json \
  apps/web/tsconfig.json \
  apps/web/vite.config.ts \
  apps/web/index.html
create_project_placeholder P003GameDemo20260513

cat > "$DEST_ROOT/README.md" <<'EOF'
# AI Ops readonly workspaces

This directory is mounted into ops-terminal as /workspace/readonly:ro.
It is for Grok/OMP inspection only. Do not put secrets here.
EOF
chmod 0444 "$DEST_ROOT/README.md"
rm -f "$DEST_ROOT/.last-sync"
date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST_ROOT/.last-sync"
chmod 0444 "$DEST_ROOT/.last-sync"
printf 'readonly sync complete: %s\n' "$DEST_ROOT"
