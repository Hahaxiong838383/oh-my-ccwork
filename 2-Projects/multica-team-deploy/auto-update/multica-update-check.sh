#!/usr/bin/env bash
# multica-update-check.sh — 检查 multica 上游 release，有新版飞书通知（通知优先，不自动应用）
#
# 策略（川哥 2026-06-02 钦定「通知优先」）：
#   每日 launchd 触发 → 查上游 latest release → 比对 mini binary 当前版本
#   → 有新版且未通知过 → 飞书通知川哥 → 写 state 防重复
#   绝不自动 pull/重建/重启（避免无人值守半夜改坏生产）
#
# env（launchd plist 注入真实值）：
#   MULTICA_NOTIFY_USER_ID  接收通知的 multica user id（必填）
#   MULTICA_BIN             multica binary 路径（默认 $HOME/bin/multica）
#   SIDECAR_BASE            飞书 sidecar 地址（默认 http://127.0.0.1:18090）
#   SPAWN_WRAPPER           lark-cli wrapper（默认 $HOME/lark_multi_user/05_agent_spawn.sh）
#   STATE_FILE             去重 state（默认 $HOME/.multica-update-check.state）
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# GitHub API 走代理（境外）；本地服务走直连
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:10808}"
export NO_PROXY="localhost,127.0.0.1,::1"

MULTICA_NOTIFY_USER_ID="${MULTICA_NOTIFY_USER_ID:-}"
MULTICA_BIN="${MULTICA_BIN:-$HOME/bin/multica}"
SIDECAR_BASE="${SIDECAR_BASE:-http://127.0.0.1:18090}"
SPAWN_WRAPPER="${SPAWN_WRAPPER:-$HOME/lark_multi_user/05_agent_spawn.sh}"
STATE_FILE="${STATE_FILE:-$HOME/.multica-update-check.state}"
REPO="multica-ai/multica"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "ERROR: $*"; exit 1; }

[ -n "$MULTICA_NOTIFY_USER_ID" ] || die "MULTICA_NOTIFY_USER_ID 未设置"
[ -x "$MULTICA_BIN" ] || die "multica binary 不可执行: $MULTICA_BIN"

# 1. 上游最新 release tag（NO_PROXY 不含 api.github.com，所以走代理）
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | jq -r '.tag_name // empty')
[ -n "$LATEST" ] || die "拿不到上游 latest release"
LATEST_NUM="${LATEST#v}"

# 2. 当前 mini binary 版本
CURRENT_NUM=$("$MULTICA_BIN" --version 2>/dev/null | head -1 | sed -E 's/^multica ([0-9][0-9.]*).*/\1/')
[ -n "$CURRENT_NUM" ] || die "拿不到当前 multica 版本"

log "current=$CURRENT_NUM latest=$LATEST_NUM"

# 3. 版本相同 → 无需通知
if [ "$CURRENT_NUM" = "$LATEST_NUM" ]; then
  log "已是最新，退出"
  exit 0
fi

# 4. semver 比较：只在 latest > current 时通知（防降级/异常 tag）
newer=$(printf '%s\n%s\n' "$CURRENT_NUM" "$LATEST_NUM" | sort -V | tail -1)
if [ "$newer" != "$LATEST_NUM" ]; then
  log "latest($LATEST_NUM) 不比 current($CURRENT_NUM) 新，跳过"
  exit 0
fi

# 5. 去重：同一 LATEST 只通知一次
if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" = "$LATEST" ]; then
  log "已通知过 $LATEST，跳过"
  exit 0
fi

# 6. 拿接收者 open_id（sidecar /status 权威源，不硬编码）
OPEN_ID=$(curl -fsS "$SIDECAR_BASE/api/feishu/device/status?multica_user_id=$MULTICA_NOTIFY_USER_ID" | jq -r '.lark_user_open_id // empty')
[ -n "$OPEN_ID" ] || die "拿不到 open_id（sidecar 未绑定？user=$MULTICA_NOTIFY_USER_ID）"

# 7. 飞书通知（通过已验证的 wrapper，HOME 隔离 + env 清理都在 wrapper 内）
MSG="🆕 multica 有新版本可更新

当前部署: v$CURRENT_NUM
上游最新: $LATEST
Release: https://github.com/$REPO/releases/tag/$LATEST

【通知优先策略】不会自动更新。确认要更新时手动执行：
- QNAP docker: docker compose pull && docker compose up -d
- mini binary: 重新下载对应版本 binary
回归风险自评后再动生产。"

RESP=$("$SPAWN_WRAPPER" "$MULTICA_NOTIFY_USER_ID" im +messages-send --user-id "$OPEN_ID" --text "$MSG" 2>&1) || die "飞书发送失败: $RESP"
if echo "$RESP" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "$LATEST" > "$STATE_FILE"
  log "已通知 $LATEST，state 已写"
else
  die "wrapper 返回非 ok: $RESP"
fi
