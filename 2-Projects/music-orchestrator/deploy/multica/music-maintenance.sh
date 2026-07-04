#!/usr/bin/env bash
# music-orchestrator 日常维护 wrapper —— 部署在 Mini（multica agent 实际执行环境）。
# multica agent 只调用本脚本的子命令，看不到 X-Music-Admin-Key 明文（key 从本机 secrets 文件读，
# 不进 multica issue 正文/metadata；呼应 feedback_multica_llm_skill_integration_pattern 的
# "skill 教 LLM 调 wrapper，wrapper 才碰真凭据" 范式，也绕开 multica 无 per-issue ACL 的可见性问题）。
#
# 用法: music-maintenance.sh report|prune [target_mb]|check-sources
set -euo pipefail

# 优先读独立 env 文件（部署时创建，权限 600，不进 git），找不到则退化读全局 secrets 文件同名 key。
for f in "$HOME/.music-orchestrator.env" "$HOME/.mycc-secrets.env"; do
  [ -f "$f" ] && source "$f"
done

: "${MUSIC_ORCHESTRATOR_BASE_URL:?未配置 MUSIC_ORCHESTRATOR_BASE_URL（部署时写入 ~/.music-orchestrator.env）}"
: "${MUSIC_ADMIN_KEY:?未配置 MUSIC_ADMIN_KEY（部署时写入 ~/.music-orchestrator.env，权限 600）}"

BASE="${MUSIC_ORCHESTRATOR_BASE_URL%/}"
AUTH_HEADER="X-Music-Admin-Key: ${MUSIC_ADMIN_KEY}"
CMD="${1:-}"

case "$CMD" in
  report)
    curl -sS --max-time 10 -H "$AUTH_HEADER" "$BASE/admin/report"
    ;;
  prune)
    TARGET_MB="${2:-}"
    if [ -n "$TARGET_MB" ]; then
      curl -sS --max-time 30 -X POST -H "$AUTH_HEADER" -H "Content-Type: application/json" \
        -d "{\"target_mb\": $TARGET_MB}" "$BASE/admin/prune-cache"
    else
      curl -sS --max-time 30 -X POST -H "$AUTH_HEADER" -H "Content-Type: application/json" \
        -d '{}' "$BASE/admin/prune-cache"
    fi
    ;;
  check-sources)
    curl -sS --max-time 20 -X POST -H "$AUTH_HEADER" "$BASE/admin/check-sources"
    ;;
  *)
    echo "用法: $0 report|prune [target_mb]|check-sources" >&2
    exit 1
    ;;
esac
