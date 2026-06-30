#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARDS="$ROOT/agent-prompt-shards"

required_shards=(
  README.md
  base-behavior.md
  agent-routing.md
  tool-source-of-truth.md
  current-info.md
  safety-boundary.md
  file-output.md
)

for shard in "${required_shards[@]}"; do
  test -s "$SHARDS/$shard" || { echo "missing shard: $shard"; exit 1; }
done

targets=(
  "$ROOT/grok-coordinator-agents/instructions-fast.md"
  "$ROOT/grok-coordinator-agents/instructions-deep.md"
  "$ROOT/gemma-direct-adapter/agent-instructions-content.md"
  "$ROOT/feishu-oauth-integration/skill-feishu-as-user.md"
  "$ROOT/theory-radar-agent/theory-radar-SKILL.md"
)

for target in "${targets[@]}"; do
  grep -q "Prompt Shard Kernel" "$target" || { echo "missing kernel marker: $target"; exit 1; }
done

grep -q "复杂任务必须派子 issue" "$ROOT/grok-coordinator-agents/instructions-fast.md" || { echo "fast coordinator routing weakened"; exit 1; }
grep -q "不知道的事实" "$ROOT/grok-coordinator-agents/instructions-deep.md" || { echo "deep worker no-guessing missing"; exit 1; }
grep -q "知识非实时" "$ROOT/gemma-direct-adapter/agent-instructions-content.md" || { echo "gemma current-info boundary missing"; exit 1; }
grep -q "sidecar /status 返回的 .*唯一权威源" "$ROOT/feishu-oauth-integration/skill-feishu-as-user.md" || { echo "feishu source-of-truth missing"; exit 1; }
grep -q "不要伪造 message_id" "$ROOT/theory-radar-agent/theory-radar-SKILL.md" || { echo "theory-radar evidence rule missing"; exit 1; }

for target in "${targets[@]}"; do
  if grep -Eq "\\{antml:|Claude Fable 5|The assistant is Claude|/mnt/user-data" "$target"; then
    echo "forbidden Claude-specific prompt residue: $target"
    exit 1
  fi
done

echo "agent prompt shards validation passed"

