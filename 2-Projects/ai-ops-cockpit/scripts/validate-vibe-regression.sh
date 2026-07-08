#!/usr/bin/env bash
set -euo pipefail
cd "${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
set -a
source .env
set +a
BASE="${AI_OPS_BASE:-https://ops.hahaxiong.top}"
PAGE=/tmp/aiops-vibe-regression.html
TASKS=/tmp/aiops-vibe-tasks.html
ASSETS=/tmp/aiops-vibe-assets.html
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/" -o "$PAGE"
python3 - "$PAGE" > /tmp/aiops-vibe-script.js <<'PY'
import sys
html=open(sys.argv[1]).read()
script=html.split('<script>',1)[1].split('</script>',1)[0]
assert 'sendTaskBtn' in script
assert "join('\\\\n')" in script or "join('\\n')" in script
print(script)
PY
node --check /tmp/aiops-vibe-script.js >/dev/null
python3 - "$PAGE" > /tmp/aiops-vibe-token.env <<'PY'
import re, sys
page=open(sys.argv[1]).read()
print('READ_TOKEN=' + re.search(r"X-AIOps-Read-Token': '([^']+)'", page).group(1))
PY
source /tmp/aiops-vibe-token.env
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/tasks" -o "$TASKS"
grep -q 'statusFilter' "$TASKS"
grep -q '复制结果' "$TASKS"
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/assets" -o "$ASSETS"
grep -q '服务器资产矩阵' "$ASSETS"
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/assets.json" | jq -e '(.servers|length)>=4 and (.workspaces|length)>=1' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/readonly-refresh.json" | jq -e 'has("mounted")' >/dev/null
sleep "${AI_OPS_REGRESSION_SLEEP:-22}"
RESP=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"mode":"readonly_inspect","question":"回归验收：请只返回 AI_OPS_REGRESSION_OK。","conversation":"川哥: 回归测试发送主按钮。"}' "$BASE/vibe/task/run")
printf "%s" "$RESP" | jq -e '.ok==true and (.answer|contains("AI_OPS_REGRESSION_OK"))' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/tasks.json" | jq -e '.tasks[0].answer|contains("AI_OPS_REGRESSION_OK")' >/dev/null
docker exec ops-terminal bash -lc 'test -f /workspace/readonly/mycc/AGENTS.md && mount | grep -q /workspace/readonly'
printf 'OK vibe regression\n'
