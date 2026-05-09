#!/usr/bin/env bash
# lark-cli 自动更新脚本
# 检查 npm 最新版本，有新版则更新
set -euo pipefail

MYCC_DIR="${HOME}/mycc"
LOG_FILE="${MYCC_DIR}/0-System/lark-cli-update.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"; }

log "=== lark-cli auto-update check ==="

CURRENT=$(node -e "console.log(require('${MYCC_DIR}/node_modules/@larksuite/cli/package.json').version)" 2>/dev/null || echo "unknown")
LATEST=$(npm view @larksuite/cli version 2>/dev/null || echo "unknown")

log "Current: ${CURRENT}, Latest: ${LATEST}"

if [ "${CURRENT}" = "${LATEST}" ] || [ "${LATEST}" = "unknown" ]; then
  log "Already up to date or cannot check, skipping"
  exit 0
fi

log "Updating @larksuite/cli ${CURRENT} -> ${LATEST}..."
cd "${MYCC_DIR}"
npm install --save-exact "@larksuite/cli@${LATEST}" 2>&1 | tee -a "${LOG_FILE}"

NEW=$(node -e "console.log(require('${MYCC_DIR}/node_modules/@larksuite/cli/package.json').version)" 2>/dev/null || echo "unknown")
log "Update complete: now at ${NEW}"
