#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/rayman.chen/mycc"
PROMPT="$ROOT/.claude/skills/scheduler/prompts/multica-daily-maintenance.md"
AGENT_ID="d107d38d-53a6-47e0-bb97-8012b38acaee"
REMOTE="mini"

if [[ ! -f "$PROMPT" ]]; then
  echo "missing prompt: $PROMPT" >&2
  exit 1
fi

ts="$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M CST')"
day="$(TZ=Asia/Shanghai date '+%Y-%m-%d')"
mode="${1:-daily}"

title="[维护] multica 每日维护 $day"
if [[ "$mode" == "manual" ]]; then
  title="[维护] multica 手动维护 $ts"
fi

desc="$(mktemp)"
trap 'rm -f "$desc"' EXIT

cat > "$desc" <<EOF
# multica 维护执行单

创建时间：$ts
创建来源：mycc scheduler -> Multica Codex agent
执行 agent：multica 运维维护员（Codex）

请立即按以下维护清单执行。执行完成后：

1. 把维护报告追加到 \`2-Projects/multica-team-deploy/auto-update/reports/maintenance-log.md\`。
2. 在本 issue 写一条中文 comment，总结健康状态、上游更新、是否自动更新、跳过/失败原因。
3. 正常完成则把本 issue 状态改为 \`in_review\`；发现需要人工介入的问题则改为 \`blocked\`。
4. 禁止在 comment 或报告中输出任何 API key、token、JWT、app secret、.env 明文。

---

$(cat "$PROMPT")
EOF

ssh -o BatchMode=yes "$REMOTE" \
  'PATH="$HOME/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"; multica issue create --title "'"$title"'" --assignee-id "'"$AGENT_ID"'" --priority high --description-stdin --output json' \
  < "$desc"
