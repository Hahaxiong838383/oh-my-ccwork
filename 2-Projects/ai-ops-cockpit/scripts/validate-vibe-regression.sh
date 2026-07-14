#!/usr/bin/env bash
set -euo pipefail
# Safety: this script sources .env. Disable xtrace so secrets are not printed
# even if the caller runs `bash -x scripts/validate-vibe-regression.sh`.
set +x
trap 'printf "FAILED vibe regression at line %s\n" "$LINENO" >&2' ERR
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
PROJECT=/tmp/aiops-vibe-project.html
CPA_PROJECT=/tmp/aiops-vibe-cpa-project.html
IPTV_PROJECT=/tmp/aiops-vibe-iptv-project.html
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/" -o "$PAGE"
python3 - "$PAGE" > /tmp/aiops-vibe-script.js <<'PY'
import sys
html=open(sys.argv[1]).read()
script=html.split('<script>',1)[1].split('</script>',1)[0]
assert 'sendTaskBtn' in script
assert "join('\\n')" in script
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
grep -q '/vibe/project?id=cpa-smart-router' "$PILOT"
grep -q '/vibe/project?id=iptv-api' "$PILOT"
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
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/assets.json" | jq -e '(.servers|length)>=5 and (.servers[] | select(.name=="阿里云日本 CPA" and .status=="已巡检" and .readinessScore>=90)) and (.workspaces|length)>=1' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="MyJavis" and .status=="enabled" and .fileCount>=8)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="chenchuan-site" and .status=="enabled" and .fileCount>=60)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="cpa-smart-router" and .status=="enabled" and .fileCount>=8)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="iptv-api" and .status=="enabled" and .fileCount>=6)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/pilot.json" | jq -e '(.projects|length)>=2 and (.workflowMatrix[] | select(.id=="patch_draft" and .permission=="draft_only"))' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/kuma-context.json" | jq -e 'has("downMonitors") and has("backup")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project?id=chenchuan-site" -o "$PROJECT"
grep -q 'chenchuan-site 项目工作区' "$PROJECT"
grep -q '每日 AI 巡检' "$PROJECT"
grep -q '生产维护通道' "$PROJECT"
python3 - "$PROJECT" > /tmp/aiops-vibe-project-script.js <<'PY'
import sys
html=open(sys.argv[1]).read()
script=html.split('<script>',1)[1].split('</script>',1)[0]
assert 'runDailyBtn' in script
assert 'inspectProductionBtn' in html
assert 'restartProductionBtn' in html
assert 'data-production-action' in script
print(script)
PY
node --check /tmp/aiops-vibe-project-script.js >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project.json?id=chenchuan-site" | jq -e '.project.allowlistCount>=60 and .context.ok==true and (.context.files|length)>=60 and .context.truncated==false and .project.production.process=="chenchuan-site" and (.workflowMatrix|length)>=4' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/live.json?id=chenchuan-site" | jq -e '.ok==true and .passed==6 and .total==6 and (.checks|length)==6' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/daily.json?id=chenchuan-site" | jq -e '.ok==true and .project=="chenchuan-site" and has("active") and has("latest")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production.json?id=chenchuan-site" | jq -e '.ok==true and .project=="chenchuan-site" and .configured==true and (.allowedActions|index("refresh-radar"))!=null and (.allowedActions|index("restart"))!=null' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project?id=cpa-smart-router" -o "$CPA_PROJECT"
grep -q '个人 CPA / Smart Router 项目工作区' "$CPA_PROJECT"
grep -q 'restart-cliproxy' "$CPA_PROJECT"
grep -q 'restart-router' "$CPA_PROJECT"
python3 - "$CPA_PROJECT" > /tmp/aiops-vibe-cpa-project-script.js <<'PY'
import sys
html=open(sys.argv[1]).read()
script=html.split('<script>',1)[1].split('</script>',1)[0]
assert 'runDailyBtn' in script
assert 'productionAction-restart-cliproxy' in html
assert 'productionAction-restart-router' in html
print(script)
PY
node --check /tmp/aiops-vibe-cpa-project-script.js >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project.json?id=cpa-smart-router" | jq -e '.project.allowlistCount>=5 and .context.ok==true and (.context.files|length)>=5 and .context.truncated==false and .project.production.processManager=="systemd" and (.workflowMatrix|length)>=4' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/live.json?id=cpa-smart-router" | jq -e '.ok==true and .passed==2 and .total==2 and (.checks|length)==2 and (.checks|all(.status==401))' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/daily.json?id=cpa-smart-router" | jq -e '.ok==true and .project=="cpa-smart-router" and has("active") and has("latest")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production.json?id=cpa-smart-router" | jq -e '.ok==true and .project=="cpa-smart-router" and .configured==true and (.allowedActions|index("restart-cliproxy"))!=null and (.allowedActions|index("restart-router"))!=null and (.allowedActions|index("k12-status"))!=null and (.allowedActions|index("k12-rotate"))!=null' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project?id=iptv-api" -o "$IPTV_PROJECT"
grep -q '私人 IPTV M3U 项目工作区' "$IPTV_PROJECT"
grep -q 'productionAction-refresh' "$IPTV_PROJECT"
grep -q 'productionAction-restart-iptv' "$IPTV_PROJECT"
grep -q 'productionAction-rollback-last-good' "$IPTV_PROJECT"
python3 - "$IPTV_PROJECT" > /tmp/aiops-vibe-iptv-project-script.js <<'PY'
import sys
html=open(sys.argv[1]).read()
script=html.split('<script>',1)[1].split('</script>',1)[0]
assert 'runDailyBtn' in script
assert 'data-production-action' in script
print(script)
PY
node --check /tmp/aiops-vibe-iptv-project-script.js >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project.json?id=iptv-api" | jq -e '.project.allowlistCount>=6 and .context.ok==true and (.context.files|length)>=6 and .context.truncated==false and .project.production.processManager=="Docker Compose" and (.workflowMatrix|length)>=4' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/live.json?id=iptv-api" | jq -e '.ok==true and .passed==1 and .total==1 and (.checks|length)==1' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/daily.json?id=iptv-api" | jq -e '.ok==true and .project=="iptv-api" and has("active") and has("latest")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production.json?id=iptv-api" | jq -e '.ok==true and .project=="iptv-api" and .configured==true and (.allowedActions|index("refresh"))!=null and (.allowedActions|index("restart-iptv"))!=null and (.allowedActions|index("rollback-last-good"))!=null' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/report.json?kind=daily" | jq -e '(.summary | has("openTodos") and has("backupOk")) and (.pilotProjects|length)>=2' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/readonly-refresh.json" | jq -e 'has("mounted")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"project":"chenchuan-site","workflow":"patch_draft"}' "$BASE/vibe/pilot/run" | jq -e '.ok==false and (.error|contains("pilot workflow"))' >/dev/null
restart_code=$(curl --http1.1 -sS -o /tmp/aiops-restart-denied.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"project":"chenchuan-site","action":"restart","confirmation":"RESTART_CHENCHUAN_SITE"}' "$BASE/vibe/project/production/action")
test "$restart_code" = "403"
jq -e '.error=="action token required"' /tmp/aiops-restart-denied.json >/dev/null
cpa_restart_code=$(curl --http1.1 -sS -o /tmp/aiops-cpa-restart-denied.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"project":"cpa-smart-router","action":"restart-router","confirmation":"RESTART_CPA_ROUTER"}' "$BASE/vibe/project/production/action")
test "$cpa_restart_code" = "403"
jq -e '.error=="action token required"' /tmp/aiops-cpa-restart-denied.json >/dev/null
iptv_restart_code=$(curl --http1.1 -sS -o /tmp/aiops-iptv-restart-denied.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"project":"iptv-api","action":"restart-iptv","confirmation":"RESTART_IPTV"}' "$BASE/vibe/project/production/action")
test "$iptv_restart_code" = "403"
jq -e '.error=="action token required"' /tmp/aiops-iptv-restart-denied.json >/dev/null
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
docker exec ops-inspector sh -lc 'test -d /var/lib/ai-ops-state && mount | grep -q /var/lib/ai-ops-state'
docker exec ops-inspector sh -lc 'test -r /run/secrets/chenchuan-maintenance/id_ed25519 && test -r /run/secrets/chenchuan-maintenance/known_hosts && mount | grep -q /run/secrets/chenchuan-maintenance'
docker exec ops-inspector sh -lc 'test -r /run/secrets/cpa-jp-maintenance/id_ed25519 && test -r /run/secrets/cpa-jp-maintenance/known_hosts && mount | grep -q /run/secrets/cpa-jp-maintenance'
docker exec ops-inspector sh -lc 'test -r /run/secrets/iptv-maintenance/id_ed25519 && test -r /run/secrets/iptv-maintenance/known_hosts && mount | grep -q /run/secrets/iptv-maintenance'
docker exec ops-terminal bash -lc 'test -f /workspace/readonly/MyJavis/README.md && test -f /workspace/readonly/chenchuan-site/README.md && test -f /workspace/readonly/chenchuan-site/src/app/page.tsx && test -f /workspace/readonly/chenchuan-site/src/lib/radar/index.ts && test -f /workspace/readonly/cpa-smart-router/README.md && test -f /workspace/readonly/cpa-smart-router/cmd/router/main.go && test -f /workspace/readonly/iptv-api/compose.yaml && test -f /workspace/readonly/iptv-api/config/config.ini && test -f /workspace/readonly/iptv-api/scripts/validate-and-publish.sh && ! test -e /workspace/readonly/MyJavis/.env && ! test -e /workspace/readonly/chenchuan-site/.env.local && ! test -e /workspace/readonly/cpa-smart-router/.env && ! test -e /workspace/readonly/cpa-smart-router/router.json && ! test -e /workspace/readonly/iptv-api/.env && ! test -e /workspace/readonly/iptv-api/output && ! test -e /workspace/readonly/chenchuan-site/src/app/api && ! test -e /workspace/readonly/chenchuan-site/src/lib/analytics && ! test -e /workspace/readonly/chenchuan-site/src/lib/chat && ! test -e /workspace/readonly/chenchuan-site/data'
printf 'OK vibe regression\n'
