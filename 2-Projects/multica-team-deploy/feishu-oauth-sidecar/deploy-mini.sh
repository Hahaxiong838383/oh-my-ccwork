#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

BIN_NAME="feishu-oauth-sidecar"
REMOTE_HOST="mini"
REMOTE_DIR="~/feishu-oauth-sidecar"
REMOTE_PLIST="~/Library/LaunchAgents/com.multica.feishu-oauth.plist"

echo "[1/4] build darwin/arm64 binary"
GOOS=darwin GOARCH=arm64 go build -o "$BIN_NAME"

echo "[2/4] rsync binary + plist to mini"
ssh "$REMOTE_HOST" 'mkdir -p ~/feishu-oauth-sidecar ~/Library/LaunchAgents ~/Library/Logs'
rsync -avz "$BIN_NAME" "$REMOTE_HOST:$REMOTE_DIR/$BIN_NAME"
# 用 mini 的真实 $HOME 替换 plist 里的占位符 (避免本地 expand 不一致)
REMOTE_HOME="$(ssh "$REMOTE_HOST" 'echo $HOME')"
sed "s|__USER_HOME__|${REMOTE_HOME}|g" com.multica.feishu-oauth.plist | \
  ssh "$REMOTE_HOST" "cat > ${REMOTE_PLIST}"

echo "[3/4] restart launch agent"
ssh "$REMOTE_HOST" 'launchctl bootout gui/$(id -u)/com.multica.feishu-oauth 2>/dev/null || true; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.multica.feishu-oauth.plist'

echo "[4/4] health check"
curl -fsS http://mini.lan:18090/healthz

echo "deploy done"
