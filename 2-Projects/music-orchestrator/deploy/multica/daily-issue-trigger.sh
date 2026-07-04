#!/usr/bin/env bash
# 每日在 multica 建一条"音乐服务日常维护" issue，触发 music-ops-skill.md 绑定的 agent 执行巡检。
# 部署在 Mini（multica CLI 所在机器），由 launchd（com.multica.music-maintenance.plist）每日调用。
#
# ⚠️ 部署时必须先跑一次 `multica issue create --help` 核对真实参数名/取值——本脚本的
#    flag 名称是按 multica CLI 一贯风格（workspace/title/description/assignee 均为 kebab-case
#    long flag）合理推测，未经实测验证，不准直接信；不符请对齐 --help 输出再改这里。
set -euo pipefail

export PATH="$HOME/bin:$PATH"

WORKSPACE_ID="${MUSIC_MULTICA_WORKSPACE_ID:?未配置 MUSIC_MULTICA_WORKSPACE_ID（部署时填入运行本脚本环境或 launchd plist EnvironmentVariables）}"
AGENT_NAME="${MUSIC_MULTICA_AGENT_NAME:-MusicOpsBot}"
BASE_URL="${MUSIC_ORCHESTRATOR_BASE_URL:?未配置 MUSIC_ORCHESTRATOR_BASE_URL}"

multica issue create \
  --workspace "$WORKSPACE_ID" \
  --title "音乐服务日常维护 $(date +%F)" \
  --description "按 music-ops-skill 三步走：拿健康报告→按阈值判断是否清缓存→探活→写总结。metadata 带 orchestrator_base_url，不含任何密钥。" \
  --assignee "$AGENT_NAME" \
  --metadata "orchestrator_base_url=$BASE_URL"
