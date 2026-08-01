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
VOICE_PROJECT=/tmp/aiops-vibe-voice-project.html
RUNTIME=/tmp/aiops-vibe-runtime.html
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
grep -q '/vibe/project?id=realtime-voice-agent' "$PILOT"
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
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/ops-runtime" -o "$RUNTIME"
grep -q 'Ops Tool Runtime' "$RUNTIME"
grep -q 'ExecutionRecord' "$RUNTIME"
grep -q 'Brain / Hands 安全架构' "$RUNTIME"
grep -q 'readonly_safe' "$RUNTIME"
docker exec ops-terminal grep -q '^setupVersion: 1$' /home/ops/.omp/terminal-agent/config.yml
docker exec ops-terminal grep -q '^  setupWizard: false$' /home/ops/.omp/terminal-agent/config.yml
runtime_json_code=$(curl --http1.1 -sS -o /tmp/aiops-runtime-no-token.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/ops-runtime.json")
test "$runtime_json_code" = "403"
jq -e '.error=="read token required"' /tmp/aiops-runtime-no-token.json >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/ops-runtime.json" | jq -e '.runtime.name=="ops-tool-runtime" and .runtime.toolCount==6 and .runtime.readonlyToolCount==4 and .runtime.confirmToolCount==1 and .runtime.blockedToolCount==1 and .architecture.brain.ok==true and .architecture.brain.toolMode=="readonly_safe" and .architecture.brain.agentDir=="/home/ops/.omp/brain-agent" and .architecture.brain.workdir=="/workspace/brain/session" and .architecture.brain.workdirReady==true and .architecture.brain.ambientExtensions==0 and .architecture.brain.directWorkspace==false and .architecture.brain.dockerSocket==false and .architecture.brain.productionSsh==false and .architecture.readonlyRunner.ok==true and .architecture.readonlyRunner.mountReadonly==true and .readonlySafe.workflow=="readonly_safe" and (.readonlySafe.tools|length)==4 and (.projects[] | select(.id=="MyJavis" and .productionConfigured==false and (.actions|length)==0)) and (.tools[] | select(.name=="run-controlled-action" and (.projects|index("MyJavis"))==null))' >/dev/null
runtime_read_code=$(curl --http1.1 -sS -o /tmp/aiops-runtime-read-denied.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" --data '{"tool":"list-project-profile","project":"chenchuan-site"}' "$BASE/vibe/ops-runtime/run")
test "$runtime_read_code" = "403"
jq -e '.error=="read token required"' /tmp/aiops-runtime-read-denied.json >/dev/null
RUNTIME_EXEC=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"tool":"list-project-profile","project":"chenchuan-site"}' "$BASE/vibe/ops-runtime/run")
printf '%s' "$RUNTIME_EXEC" | jq -e '.ok==true and .result.profile.id=="chenchuan-site" and .execution.risk=="readonly" and .execution.secretExposure==0' >/dev/null
RUNTIME_EXEC_ID=$(printf '%s' "$RUNTIME_EXEC" | jq -r '.execution.id')
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/ops-runtime/execution?id=$RUNTIME_EXEC_ID" | jq -e --arg id "$RUNTIME_EXEC_ID" '.id==$id and .tool=="list-project-profile" and .secretExposure==0' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"tool":"deploy-or-shell","project":"chenchuan-site"}' "$BASE/vibe/ops-runtime/run" | jq -e '.ok==false and .error=="tool blocked by policy"' >/dev/null
runtime_action_code=$(curl --http1.1 -sS -o /tmp/aiops-runtime-action-denied.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"tool":"run-controlled-action","project":"chenchuan-site","action":"restart","confirmation":"RESTART_CHENCHUAN_SITE"}' "$BASE/vibe/ops-runtime/run")
test "$runtime_action_code" = "403"
jq -e '.error=="action token required"' /tmp/aiops-runtime-action-denied.json >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/assets.json" | jq -e '(.servers|length)>=6 and (.servers[] | select(.name=="阿里云日本 CPA" and .status=="已巡检" and .readinessScore>=90)) and (.servers[] | select(.name=="企航云香港 Voice Worker" and .status=="已巡检" and .readinessScore>=90)) and (.workspaces|length)>=1' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="MyJavis" and .status=="enabled" and .fileCount>=8)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="chenchuan-site" and .status=="enabled" and .fileCount>=60)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="cpa-smart-router" and .status=="enabled" and .fileCount>=8)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="iptv-api" and .status=="enabled" and .fileCount>=6)' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/allowlist.json" | jq -e '.projects[] | select(.name=="realtime-voice-agent" and .status=="enabled" and .fileCount>=20)' >/dev/null
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
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production.json?id=chenchuan-site" | jq -e '.ok==true and .project=="chenchuan-site" and .configured==true and (.allowedActions|index("refresh-radar"))!=null and (.allowedActions|index("run-theory-radar"))!=null and (.allowedActions|index("restart-theory-radar-timers"))!=null and (.allowedActions|index("restart"))!=null' >/dev/null
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
assert 'productionAction-k12-status' in html
assert 'Boolean(config.confirmation)' in script
print(script)
PY
node --check /tmp/aiops-vibe-cpa-project-script.js >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project.json?id=cpa-smart-router" | jq -e '.project.allowlistCount>=5 and .context.ok==true and (.context.files|length)>=5 and .context.truncated==false and .project.production.processManager=="systemd" and (.workflowMatrix|length)>=4' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/live.json?id=cpa-smart-router" | jq -e '.ok==true and .passed==2 and .total==2 and (.checks|length)==2 and (.checks|all(.status==401))' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/daily.json?id=cpa-smart-router" | jq -e '.ok==true and .project=="cpa-smart-router" and has("active") and has("latest")' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production.json?id=cpa-smart-router" | jq -e '.ok==true and .project=="cpa-smart-router" and .configured==true and (.allowedActions|index("restart-cliproxy"))!=null and (.allowedActions|index("restart-router"))!=null and (.allowedActions|index("k12-status"))!=null and (.allowedActions|index("k12-rotate"))!=null' >/dev/null
CPA_K12_JOB=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"project":"cpa-smart-router","action":"k12-status"}' "$BASE/vibe/project/production/action" | jq -er 'select(.ok==true) | .jobId')
test -n "$CPA_K12_JOB"
CPA_K12_STATUS="queued"
for _ in $(seq 1 45); do
  curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production/job?id=$CPA_K12_JOB" -o /tmp/aiops-cpa-k12-job.json
  CPA_K12_STATUS=$(jq -r '.status' /tmp/aiops-cpa-k12-job.json)
  test "$CPA_K12_STATUS" = "queued" -o "$CPA_K12_STATUS" = "running" || break
  sleep 1
done
test "$CPA_K12_STATUS" = "done"
jq -e '.ok==true and .result.ok==true and (.result.k12.count>=0)' /tmp/aiops-cpa-k12-job.json >/dev/null
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
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production.json?id=iptv-api" | jq -e '.ok==true and .project=="iptv-api" and .configured==true and (.allowedActions|index("refresh"))!=null and (.allowedActions|index("repair-publish-timer"))!=null and (.allowedActions|index("restart-iptv"))!=null and (.allowedActions|index("rollback-last-good"))!=null' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project?id=realtime-voice-agent" -o "$VOICE_PROJECT"
grep -q 'Realtime Voice Agent 项目工作区' "$VOICE_PROJECT"
grep -q 'productionAction-restart-voice-worker' "$VOICE_PROJECT"
python3 - "$VOICE_PROJECT" > /tmp/aiops-vibe-voice-project-script.js <<'PY'
import sys
html=open(sys.argv[1]).read()
script=html.split('<script>',1)[1].split('</script>',1)[0]
assert 'runDailyBtn' in script
assert 'data-production-action' in script
print(script)
PY
node --check /tmp/aiops-vibe-voice-project-script.js >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project.json?id=realtime-voice-agent" | jq -e '.project.allowlistCount>=20 and .context.ok==true and (.context.files|length)>=20 and .context.truncated==false and .project.production.processManager=="systemd" and (.workflowMatrix|length)>=4' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/live.json?id=realtime-voice-agent" | jq -e '.ok==true and .passed==1 and .total==1 and (.checks|length)==1' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/project/production.json?id=realtime-voice-agent" | jq -e '.ok==true and .project=="realtime-voice-agent" and .configured==true and (.allowedActions|index("inspect"))!=null and (.allowedActions|index("restart-voice-worker"))!=null' >/dev/null
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
voice_restart_code=$(curl --http1.1 -sS -o /tmp/aiops-voice-restart-denied.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"project":"realtime-voice-agent","action":"restart-voice-worker","confirmation":"RESTART_VOICE_WORKER"}' "$BASE/vibe/project/production/action")
test "$voice_restart_code" = "403"
jq -e '.error=="action token required"' /tmp/aiops-voice-restart-denied.json >/dev/null
voice_bad_confirmation_code=$(curl --http1.1 -sS -o /tmp/aiops-voice-bad-confirmation.json -w '%{http_code}' -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" -H "X-AIOps-Action-Token: $OPS_ACTION_TOKEN" --data '{"project":"realtime-voice-agent","action":"restart-voice-worker","confirmation":"WRONG"}' "$BASE/vibe/project/production/action")
test "$voice_bad_confirmation_code" = "200"
jq -e '.ok==false and .error=="action confirmation required" and (has("jobId")|not)' /tmp/aiops-voice-bad-confirmation.json >/dev/null
sleep "${AI_OPS_REGRESSION_SLEEP:-22}"
RESP=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data '{"mode":"readonly_inspect","project":"chenchuan-site","question":"回归验收：必须调用 aiops_read 读取 chenchuan-site 的 README.md 第 1 行，然后返回 AI_OPS_REGRESSION_OK，并明确写出 readonly_safe。","conversation":"川哥: 回归测试发送主按钮与安全只读工具。"}' "$BASE/vibe/task/run")
printf "%s" "$RESP" | jq -e '.ok==true and .toolMode=="readonly_safe" and .brainBoundary=="model-only-no-docker-no-ssh" and (.answer|contains("AI_OPS_REGRESSION_OK")) and (.answer|contains("readonly_safe"))' >/dev/null
TASK_ID=$(printf '%s' "$RESP" | jq -r '.id')
export TASK_ID
docker exec -e MODEL_TASK_ID="$TASK_ID" ops-tool-runner python -c 'import glob,json,os; records=[json.load(open(path,encoding="utf-8")) for path in glob.glob("/var/lib/aiops-tool-runner/audit/*.json")[-120:]]; assert any(item.get("taskId")==os.environ["MODEL_TASK_ID"] and item.get("tool")=="read" and item.get("decision")=="allowed" for item in records)'
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/tasks.json" | jq -e --arg id "$TASK_ID" '.tasks[0].id==$id and (.tasks[0].answer|contains("AI_OPS_REGRESSION_OK"))' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"taskId\":\"$TASK_ID\"}" "$BASE/vibe/todos/create" | jq -e '.ok==true and .todo.taskId==env.TASK_ID' >/dev/null
TODO_ID=$(curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "X-AIOps-Read-Token: $READ_TOKEN" "$BASE/vibe/todos.json" | jq -r '.todos[0].id')
export TODO_ID
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"todoId\":\"$TODO_ID\",\"status\":\"doing\"}" "$BASE/vibe/todos/update" | jq -e '.ok==true and .todo.status=="doing"' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"todoId\":\"$TODO_ID\"}" "$BASE/vibe/todos/inspect" | jq -e '.ok==true and .todoId==env.TODO_ID' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" -H "origin: https://ops.hahaxiong.top" -H "content-type: application/json" -H "X-AIOps-Read-Token: $READ_TOKEN" --data "{\"todoId\":\"$TODO_ID\",\"action\":\"inspect\"}" "$BASE/vibe/todos/action" | jq -e '.ok==true and .todoId==env.TODO_ID' >/dev/null
curl --http1.1 -fsS -u "chuan:${OPS_AUTH_PASSWORD}" "$BASE/vibe/todos/detail?id=$TODO_ID" -o /tmp/aiops-vibe-todo-detail.html
grep -q '待办详情' /tmp/aiops-vibe-todo-detail.html
docker exec ops-terminal bash -lc 'test -x /usr/local/bin/omp-aiops && /usr/local/bin/omp-aiops --version | grep -Eq "^omp/[0-9]+\\.[0-9]+\\.[0-9]+$"'
docker exec ops-terminal bash -lc 'test -r /run/secrets/volcengine_coding_api_key && /usr/local/bin/omp-aiops models find "$AI_OPS_OMP_MODEL" --json | grep -q deepseek-v4-pro'
docker exec ops-terminal bash -lc 'test ! -S /var/run/docker.sock && test ! -e /run/secrets/chenchuan-maintenance && test ! -e /workspace/readonly && test ! -e /workspace/projects && test ! -e /workspace/stacks && ! command -v docker && ! command -v ssh && ! command -v sudo'
docker exec ops-brain bash -lc 'test -r /run/secrets/volcengine_coding_api_key && test ! -S /var/run/docker.sock && test ! -e /run/secrets/chenchuan-maintenance && test ! -e /workspace/readonly && test ! -e /workspace/projects && test ! -e /workspace/stacks && ! command -v docker && ! command -v ssh && ! command -v sudo'
docker exec ops-tool-runner sh -lc 'test ! -e /run/secrets/volcengine_coding_api_key && test ! -S /var/run/docker.sock && test ! -e /run/secrets/chenchuan-maintenance && ! env | grep -Eq "FEISHU_WEBHOOK|PUSH_URL|OMP_MODEL|VOLCENGINE"'
docker inspect ops-terminal ops-brain | jq -e 'all(.[]; ([.Mounts[].Destination] | index("/var/run/docker.sock") | not) and ([.Mounts[].Destination] | index("/workspace/readonly") | not) and ([.Mounts[].Destination] | index("/workspace/projects/ai-ops-cockpit") | not))' >/dev/null
docker inspect ops-brain ops-tool-runner | jq -e 'all(.[]; .State.Health.Status=="healthy")' >/dev/null
docker inspect ops-tool-runner | jq -e '.[0].HostConfig.ReadonlyRootfs==true and (.[0].HostConfig.CapDrop|index("ALL"))!=null and ([.[0].Mounts[].Destination]|index("/workspace/readonly"))!=null and ([.[0].Mounts[]|select(.Destination=="/workspace/readonly")|.RW]|all(.==false)) and ([.[0].Mounts[]|select(.Destination=="/var/lib/aiops-tool-runner")|.Type]|index("volume"))!=null' >/dev/null
UNAUTHORIZED_RUNNER_CODE=$(docker exec ops-brain sh -lc 'curl -sS -o /tmp/unauthorized-runner.json -w "%{http_code}" -H "content-type: application/json" --data '\''{"taskId":"regression-unauthorized","project":"chenchuan-site","workflow":"readonly_safe","tool":"read","params":{"path":"README.md"}}'\'' http://ops-tool-runner:8091/tool')
test "$UNAUTHORIZED_RUNNER_CODE" = "403"
SAFE_READ=$(docker exec ops-brain sh -lc 'curl -fsS -H "content-type: application/json" -H "x-aiops-internal-token: $AI_OPS_INTERNAL_TOKEN" --data '\''{"taskId":"regression-safe-read","project":"chenchuan-site","workflow":"readonly_safe","tool":"read","params":{"path":"README.md","startLine":1,"lineCount":3}}'\'' http://ops-tool-runner:8091/tool')
printf '%s' "$SAFE_READ" | jq -e '.ok==true and .data.path=="README.md" and .data.lineCount>=1' >/dev/null
BLOCKED_WRITE=$(docker exec ops-brain sh -lc 'curl -sS -H "content-type: application/json" -H "x-aiops-internal-token: $AI_OPS_INTERNAL_TOKEN" --data '\''{"taskId":"regression-block-write","project":"chenchuan-site","workflow":"readonly_safe","tool":"write","params":{"path":"README.md"}}'\'' http://ops-tool-runner:8091/tool')
printf '%s' "$BLOCKED_WRITE" | jq -e '.ok==false and .error=="policy_denied"' >/dev/null
BLOCKED_TRAVERSAL=$(docker exec ops-brain sh -lc 'curl -sS -H "content-type: application/json" -H "x-aiops-internal-token: $AI_OPS_INTERNAL_TOKEN" --data '\''{"taskId":"regression-block-traversal","project":"chenchuan-site","workflow":"readonly_safe","tool":"read","params":{"path":"../../etc/passwd"}}'\'' http://ops-tool-runner:8091/tool')
printf '%s' "$BLOCKED_TRAVERSAL" | jq -e '.ok==false and .error=="policy_denied"' >/dev/null
for payload in \
  '{"taskId":"regression-absolute","project":"chenchuan-site","workflow":"readonly_safe","tool":"read","params":{"path":"/etc/passwd"}}' \
  '{"taskId":"regression-sensitive","project":"chenchuan-site","workflow":"readonly_safe","tool":"read","params":{"path":".env"}}' \
  '{"taskId":"regression-project","project":"unknown-project","workflow":"readonly_safe","tool":"read","params":{"path":"README.md"}}' \
  '{"taskId":"regression-workflow","project":"chenchuan-site","workflow":"diagnose","tool":"read","params":{"path":"README.md"}}'; do
  docker exec -e POLICY_PAYLOAD="$payload" ops-brain sh -lc 'curl -sS -H "content-type: application/json" -H "x-aiops-internal-token: $AI_OPS_INTERNAL_TOKEN" --data "$POLICY_PAYLOAD" http://ops-tool-runner:8091/tool' | jq -e '.ok==false and (.error=="policy_denied" or .error=="snapshot_not_ready")' >/dev/null
done
docker exec ops-tool-runner python -c 'import glob,json; records=[json.load(open(path,encoding="utf-8")) for path in glob.glob("/var/lib/aiops-tool-runner/audit/*.json")[-80:]]; assert any(item.get("taskId")=="regression-safe-read" and item.get("decision")=="allowed" for item in records); assert any(item.get("taskId")=="regression-block-write" and item.get("decision")=="blocked" for item in records); assert all(item.get("secretExposure")==0 for item in records); assert all("path" not in (item.get("paramsSummary") or {}) for item in records); assert all("query" not in (item.get("paramsSummary") or {}) for item in records); assert all("path" not in (item.get("resultSummary") or {}) for item in records)'
docker exec ops-inspector sh -lc 'test -d /var/lib/ai-ops-state && mount | grep -q /var/lib/ai-ops-state'
docker exec ops-inspector sh -lc 'test -r /run/secrets/chenchuan-maintenance/id_ed25519 && test -r /run/secrets/chenchuan-maintenance/known_hosts && mount | grep -q /run/secrets/chenchuan-maintenance'
docker exec ops-inspector sh -lc 'test -r /run/secrets/cpa-jp-maintenance/id_ed25519 && test -r /run/secrets/cpa-jp-maintenance/known_hosts && mount | grep -q /run/secrets/cpa-jp-maintenance'
docker exec ops-inspector sh -lc 'test -r /run/secrets/iptv-maintenance/id_ed25519 && test -r /run/secrets/iptv-maintenance/known_hosts && mount | grep -q /run/secrets/iptv-maintenance'
docker exec ops-inspector sh -lc 'test -r /run/secrets/qihang-hk-maintenance/id_ed25519 && test -r /run/secrets/qihang-hk-maintenance/known_hosts && mount | grep -q /run/secrets/qihang-hk-maintenance'
docker exec ops-inspector python -c 'import server; data=server.parse_maintenance_response("{\n  \"ok\": true,\n  \"k12\": {\"count\": 2}\n}\n"); assert data["ok"] is True and data["k12"]["count"]==2'
docker exec ops-tool-runner sh -lc 'test -f /workspace/readonly/MyJavis/README.md && test -f /workspace/readonly/chenchuan-site/README.md && test -f /workspace/readonly/chenchuan-site/src/app/page.tsx && test -f /workspace/readonly/chenchuan-site/src/lib/radar/index.ts && test -f /workspace/readonly/chenchuan-site/docs/theory-radar-aiops-handoff.md && test -f /workspace/readonly/chenchuan-site/services/theory-radar/theory_radar.py && test -f /workspace/readonly/cpa-smart-router/README.md && test -f /workspace/readonly/cpa-smart-router/cmd/router/main.go && test -f /workspace/readonly/iptv-api/compose.yaml && test -f /workspace/readonly/iptv-api/config/config.ini && test -f /workspace/readonly/iptv-api/scripts/validate-and-publish.sh && test -f /workspace/readonly/iptv-api/scripts/install-validate-publish-timer.sh && test -f /workspace/readonly/iptv-api/systemd/iptv-validate-publish.timer && test -f /workspace/readonly/realtime-voice-agent/README.md && test -f /workspace/readonly/realtime-voice-agent/pyproject.toml && test -f /workspace/readonly/realtime-voice-agent/src/voice_agent/kernel/memory_kernel.py && test -f /workspace/readonly/realtime-voice-agent/tests/test_contract.py && ! test -e /workspace/readonly/MyJavis/.env && ! test -e /workspace/readonly/chenchuan-site/.env.local && ! test -e /workspace/readonly/chenchuan-site/services/theory-radar/.env && ! test -e /workspace/readonly/cpa-smart-router/.env && ! test -e /workspace/readonly/cpa-smart-router/router.json && ! test -e /workspace/readonly/iptv-api/.env && ! test -e /workspace/readonly/iptv-api/output && ! test -e /workspace/readonly/realtime-voice-agent/.env && ! test -e /workspace/readonly/realtime-voice-agent/data && ! test -e /workspace/readonly/realtime-voice-agent/assets/models && ! test -e /workspace/readonly/realtime-voice-agent/assets/speakers && ! test -e /workspace/readonly/chenchuan-site/src/app/api && ! test -e /workspace/readonly/chenchuan-site/src/lib/analytics && ! test -e /workspace/readonly/chenchuan-site/src/lib/chat && ! test -e /workspace/readonly/chenchuan-site/data'
printf 'OK vibe regression\n'
