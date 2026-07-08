#!/usr/bin/env bash
set -euo pipefail

ROOT="${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
SRC_ROOT="${AI_OPS_READONLY_SRC:-/opt/ai-ops-readonly-src}"
DEST_ROOT="$ROOT/readonly"
mkdir -p "$SRC_ROOT" "$DEST_ROOT"

sync_repo() {
  local name="$1"
  local remote="$2"
  local branch="${3:-}"
  local src="$SRC_ROOT/$name"
  local dest="$DEST_ROOT/$name"
  if [ ! -d "$src/.git" ]; then
    git clone --filter=blob:none "$remote" "$src"
  else
    git -C "$src" remote set-url origin "$remote"
    git -C "$src" fetch --prune origin
  fi
  if [ -n "$branch" ]; then
    git -C "$src" checkout -q "$branch"
    git -C "$src" reset --hard -q "origin/$branch"
  else
    local default_branch
    default_branch="$(git -C "$src" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
    default_branch="${default_branch:-main}"
    git -C "$src" checkout -q "$default_branch"
    git -C "$src" reset --hard -q "origin/$default_branch"
  fi
  rsync -a --delete \
    --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' --exclude 'id_rsa*' \
    --exclude 'node_modules' --exclude '.venv' --exclude 'venv' --exclude '__pycache__' \
    --exclude '.DS_Store' --exclude 'dist' --exclude 'build' --exclude '.next' \
    "$src/" "$dest/"
  find "$dest" -type d -exec chmod 0555 {} +
  find "$dest" -type f -exec chmod 0444 {} +
  git -C "$dest" status --short --branch | head -n 20 || true
}

if [ -d "$ROOT/.git" ]; then
  mkdir -p "$DEST_ROOT/mycc"
  rsync -a --delete \
    --exclude '.git' --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' --exclude 'id_rsa*' \
    --exclude 'node_modules' --exclude '.venv' --exclude 'venv' --exclude '__pycache__' \
    --exclude '.DS_Store' --exclude 'dist' --exclude 'build' --exclude '.next' \
    "$ROOT/" "$DEST_ROOT/mycc/"
  find "$DEST_ROOT/mycc" -type d -exec chmod 0555 {} +
  find "$DEST_ROOT/mycc" -type f -exec chmod 0444 {} +
else
  if ! sync_repo mycc "https://github.com/Hahaxiong838383/oh-my-ccwork.git" main; then
    mkdir -p "$DEST_ROOT/mycc"
    cat > "$DEST_ROOT/mycc/README.md" <<'EOF'
# mycc readonly snapshot pending

This host cannot clone the repository without credentials. Push a sanitized snapshot from the trusted local machine with rsync.
EOF
    chmod 0555 "$DEST_ROOT/mycc"
    chmod 0444 "$DEST_ROOT/mycc/README.md"
  fi
fi

cat > "$DEST_ROOT/README.md" <<'EOF'
# AI Ops readonly workspaces

This directory is mounted into ops-terminal as /workspace/readonly:ro.
It is for Grok/OMP inspection only. Do not put secrets here.
EOF
chmod 0444 "$DEST_ROOT/README.md"

printf 'readonly sync complete: %s\n' "$DEST_ROOT"
