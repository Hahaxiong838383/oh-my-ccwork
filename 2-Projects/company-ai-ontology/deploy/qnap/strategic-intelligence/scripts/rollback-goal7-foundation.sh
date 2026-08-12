#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_ROLLBACK_APPROVED:-}" = YES ] || { echo 'Goal 7 rollback requires explicit GOAL7_ROLLBACK_APPROVED=YES' >&2; exit 2; }
backup_root=${GOAL7_BACKUP_ROOT:?GOAL7_BACKUP_ROOT is required}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
manifest=$backup_root/release-manifest.txt
[ -f "$manifest" ] && [ ! -L "$manifest" ] || { echo 'Goal 7 backup manifest missing' >&2; exit 2; }
[ -f "$backup_root/.env" ] && [ -f "$backup_root/docker-compose.yml" ] || { echo 'Goal 7 backup config incomplete' >&2; exit 2; }

run_id=$(awk -F= '/^run_id=/{print $2;exit}' "$manifest")
[ -n "$run_id" ] || { echo 'Goal 7 backup run id missing' >&2; exit 2; }
for service in agent-core knowledge-connector h-lite; do
  previous=company-ai-foundation-$service:goal7-pre-$run_id
  "$docker_path" image inspect "$previous" >/dev/null || { echo "Goal 7 rollback image missing: $service" >&2; exit 2; }
done

cd "$foundation_root"
"$docker_path" compose config >/dev/null
h_lite_admin() {
  action=$1
  stop_transport=${2:-0}
  "$docker_path" compose exec -T h-lite node -e \
    "const action=process.argv[1],stop=process.argv[2];fetch('http://127.0.0.1:8081/v1/admin/'+action,{method:'POST',headers:{'x-h-lite-shadow-token':process.env.H_LITE_SHADOW_TOKEN,'x-h-lite-stop-transport':stop}}).then(async r=>{const p=await r.json();process.exit(r.ok&&((action==='drain'&&p.status==='drained'&&p.inFlight===0)||(action==='resume'&&p.status==='resumed'))?0:1)}).catch(()=>process.exit(1))" \
    "$action" "$stop_transport" </dev/null >/dev/null 2>&1
}
wait_h_lite_recovered() {
  attempt=0
  until "$docker_path" compose exec -T h-lite node -e \
    "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.draining===false&&p.inFlight===0&&p.pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
h_lite_admin drain 1 || { echo 'Goal 7 rollback requires recovery-capable H-Lite drain before service replacement' >&2; exit 1; }
if ! "$docker_path" compose exec -T h-lite node -e \
  "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
  </dev/null >/dev/null 2>&1; then
  h_lite_admin resume 0 || { echo 'Goal 7 rollback could not resume H-Lite after pending delivery gate' >&2; exit 1; }
  wait_h_lite_recovered || { echo 'Goal 7 rollback pending H-Lite deliveries did not clear' >&2; exit 1; }
  h_lite_admin drain 1 || { echo 'Goal 7 rollback final H-Lite drain failed' >&2; exit 1; }
fi
"$docker_path" compose exec -T h-lite node -e \
  "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.draining===true&&p.inFlight===0&&p.pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
  </dev/null >/dev/null 2>&1 || { echo 'Goal 7 rollback H-Lite continuity gate failed' >&2; exit 1; }
"$docker_path" compose exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/v1/admin/drain',{method:'POST',headers:{'x-agent-core-drain-token':process.env.AGENT_CORE_HMAC_SECRET,'x-agent-core-drain-timeout-ms':'90000'}}).then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='drained'&&p.activeRequests===0?0:1)}).catch(()=>process.exit(1))" \
  </dev/null >/dev/null 2>&1 || { echo 'Goal 7 rollback Agent Core drain gate failed' >&2; exit 1; }

cp "$backup_root/.env" "$foundation_root/.env"
cp "$backup_root/docker-compose.yml" "$foundation_root/docker-compose.yml"
chmod 600 "$foundation_root/.env" "$foundation_root/docker-compose.yml"
for service in agent-core knowledge-connector h-lite; do
  previous=company-ai-foundation-$service:goal7-pre-$run_id
  "$docker_path" image tag "$previous" company-ai-foundation-$service:latest
done
"$docker_path" compose config >/dev/null
for service in agent-core knowledge-connector h-lite; do
  "$docker_path" compose up -d --no-deps --no-build "$service" >/dev/null
done

attempt=0
until "$docker_path" compose exec -T agent-core node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1 \
  && "$docker_path" compose exec -T knowledge-connector node -e "fetch('http://127.0.0.1:8083/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1 \
  && "$docker_path" compose exec -T h-lite node -e "fetch('http://127.0.0.1:8081/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1; do
  attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || { echo 'Goal 7 rollback health verification timed out' >&2; exit 1; }; sleep 2
done
printf 'goal7_rollback=%s\nrestored_services=3\nmigration012_retained=true\n' "$backup_root"
