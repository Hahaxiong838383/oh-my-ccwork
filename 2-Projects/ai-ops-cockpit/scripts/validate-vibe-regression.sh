#!/usr/bin/env bash
set -euo pipefail
# Safety: this script sources .env. Disable xtrace so secrets are not printed
# even if the caller runs `bash -x scripts/validate-vibe-regression.sh`.
set +x
cd "${AI_OPS_ROOT:-/opt/ai-ops-cockpit}"
set -a
source .env
set +a
BASE="${AI_OPS_BASE:-https://ops.hahaxiong.top}"
PAGE=/tmp/aiops-vibe-regression.html
TASKS=/tmp/aiops-vibe-tasks.html
ASSETS=/tmp/aiops-vibe-assets.html
TODOS=/tmp/aiops-vibe-todos.html
PILOT=/tmp/aiops-vibe-pilot.html
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
grep -q '转待办' "$TASKS"
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/todos" -o "$TODOS"
grep -q 'AI Ops 待办' "$TODOS"
grep -q '发飞书' "$TODOS"
grep -q '巡检' "$TODOS"
grep -q 'todoSearch' "$TODOS"
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/pilot" -o "$PILOT"
grep -q '真实项目实战试点' "$PILOT"
grep -q 'Workflow 权限矩阵' "$PILOT"
grep -q '/vibe/project?id=chenchuan-site' "$PILOT"
python3 - "$PILOT" > /tmp/aiops-vibe-pilot-script.js <<'PY'
import sys
html=open(sys.argv[1]).read()
script=html.split('<script>',1)[1].split('</script>',1)[0]
assert 'runPilotBtn' in script
print(script)
PY
node --check /tmp/aiops-vibe-pilot-script.js >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/assets" -o "$ASSETS"
grep -q '服务器资产矩阵' "$ASSETS"
grep -q '项目文件级 Allowlist' "$ASSETS"
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/assets.json" | jq -e '(.servers|length)>=4 and (.workspaces|length)>=1' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="MyJavis" and .status=="enabled" and .fileCount>=8)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="chenchuan-site" and .status=="enabled" and .fileCount>=4)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/pilot.json" | jq -e '(.projects|length)>=2 and (.workflowMatrix[] | select(.id=="patch_draft" and .permission=="draft_only"))' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/kuma-context.json" | jq -e 'has("downMonitors") and has("backup")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project?id=chenchuan-site" | grep -q 'chenchuan-site 项目工作区'
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project.json?id=chenchuan-site" | jq -e '.project.allowlistCount>=4 and (.workflowMatrix|length)>=4' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/report.json?kind=daily" | jq -e '(.summary | has("openTodos") and has("backupOk")) and (.pilotProjects|length)>=2' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/readonly-refresh.json" | jq -e 'has("mounted")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"project":"chenchuan-site","workflow":"patch_draft"}' "$BASE/vibe/pilot/run" | jq -e '.ok==false and (.error|contains("pilot workflow"))' >/dev/null
sleep "${AI_OPS_REGRESSION_SLEEP:-22}"
RESP=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"mode":"readonly_inspect","question":"回归验收：请只返回 AI_OPS_REGRESSION_OK。","conversation":"川哥: 回归测试发送主按钮。"}' "$BASE/vibe/task/run")
printf "%s" "$RESP" | jq -e '.ok==true and (.answer|contains("AI_OPS_REGRESSION_OK"))' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/tasks.json" | jq -e '.tasks[0].answer|contains("AI_OPS_REGRESSION_OK")' >/dev/null
TASK_ID=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/tasks.json" | jq -r '.tasks[0].id')
export TASK_ID
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"taskId\":\"$TASK_ID\"}" "$BASE/vibe/todos/create" | jq -e '.ok==true and .todo.taskId==env.TASK_ID' >/dev/null
TODO_ID=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/todos.json" | jq -r '.todos[0].id')
export TODO_ID
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"todoId\":\"$TODO_ID\",\"status\":\"doing\"}" "$BASE/vibe/todos/update" | jq -e '.ok==true and .todo.status=="doing"' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"todoId\":\"$TODO_ID\"}" "$BASE/vibe/todos/inspect" | jq -e '.ok==true and .todoId==env.TODO_ID' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"todoId\":\"$TODO_ID\",\"action\":\"inspect\"}" "$BASE/vibe/todos/action" | jq -e '.ok==true and .todoId==env.TODO_ID' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/todos/detail?id=$TODO_ID" | grep -q '待办详情'
docker exec ops-terminal bash -lc 'test -f /workspace/readonly/mycc/AGENTS.md && mount | grep -q /workspace/readonly'
docker exec ops-terminal bash -lc 'test -f /workspace/readonly/MyJavis/README.md && test -f /workspace/readonly/chenchuan-site/README.md && ! test -e /workspace/readonly/MyJavis/.env && ! test -e /workspace/readonly/chenchuan-site/.env.local'
printf 'OK vibe regression\n'
