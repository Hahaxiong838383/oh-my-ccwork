#!/bin/sh
set -eu
exec </dev/null

project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
principal_key=${GOAL4_PRINCIPAL_KEY:-goal4-fixture-reader}

case "$principal_key" in
  *[!A-Za-z0-9_-]*|'') echo 'invalid fixture principal key' >&2; exit 2 ;;
esac

cd "$project_root"

replay_signature() {
  "$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -AtF ':' -c \
    "SELECT c.id::text, count(DISTINCT s.id), count(DISTINCT e.event_id)
       FROM work.brain_cases c
       JOIN work.brain_case_stages s ON s.tenant_id=c.tenant_id AND s.case_id=c.id
       JOIN work.brain_case_events e ON e.tenant_id=c.tenant_id AND e.case_id=c.id
      WHERE c.principal_external_key = '$principal_key'
      GROUP BY c.id
      ORDER BY max(c.started_at) DESC
      LIMIT 1;"
}

before=$(replay_signature)
test -n "$before"
"$docker_path" compose restart agent-core >/dev/null
attempt=0
until "$docker_path" compose exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/status/work-protocol').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='active'?0:1)}).catch(()=>process.exit(1))" \
  </dev/null >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || exit 1
  sleep 2
done
after=$(replay_signature)
[ "$before" = "$after" ]
printf 'replay_signature_preserved=true\n'

logs=/tmp/goal4-services-$$.log
trap 'rm -f "$logs"' EXIT INT TERM
"$docker_path" compose logs --no-color --since 60m agent-core ontology-registry gateway > "$logs"
secret_value_matches=0
for key in AGENT_CORE_HMAC_SECRET H_ENGINE_REMOTE_SECRET ONTOLOGY_REGISTRY_CONTROL_TOKEN CPA_API_KEY FEISHU_APP_SECRET; do
  value=$(sed -n "s/^${key}=//p" .env | head -1)
  if [ -n "$value" ] && grep -Fq -- "$value" "$logs"; then
    secret_value_matches=$((secret_value_matches + 1))
  fi
done
generic_secret_patterns=$(grep -Eci 'Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{16,}|api[_-]?key[=:][^[:space:]]{12,}' "$logs" || true)
printf 'secret_value_matches=%s generic_secret_patterns=%s\n' "$secret_value_matches" "$generic_secret_patterns"
[ "$secret_value_matches" -eq 0 ]
[ "$generic_secret_patterns" -eq 0 ]

container=$("$docker_path" compose ps -q agent-core)
restart_count=$("$docker_path" inspect --format '{{.RestartCount}}' "$container")
printf 'agent_core_restart_count=%s\n' "$restart_count"
[ "$restart_count" -eq 0 ]
