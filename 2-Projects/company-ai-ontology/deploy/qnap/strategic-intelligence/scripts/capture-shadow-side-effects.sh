#!/bin/sh
set -eu
exec </dev/null

started_at=${1:?started at is required}
completed_at=${2:?completed at is required}
output_file=${3:?output file is required}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"

cd "$foundation_root"
set -a
. ./.env
set +a
temporary=$output_file.partial
"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" \
  --set=started_at="$started_at" \
  --set=completed_at="$completed_at" \
  -At <<'SQL' > "$temporary"
SELECT json_build_object(
  'auditVersion', '1.0.0',
  'completed', true,
  'windowStart', :'started_at'::timestamptz,
  'windowEnd', :'completed_at'::timestamptz,
  'formalP2Count', (
    SELECT count(*)::integer FROM ontology.entities
    WHERE tenant_id = :'tenant_id'::uuid
      AND entity_type = 'p2'
      AND created_at BETWEEN :'started_at'::timestamptz AND :'completed_at'::timestamptz
      AND (external_key LIKE 'p1-si-%' OR attributes->>'source' = 'strategic-intelligence')
  ),
  'employeeDeliveryCount', (
    SELECT count(*)::integer FROM delivery.outbox
    WHERE tenant_id = :'tenant_id'::uuid
      AND created_at BETWEEN :'started_at'::timestamptz AND :'completed_at'::timestamptz
      AND (idempotency_key LIKE 'p1-si-%' OR payload->>'source' = 'strategic-intelligence')
  ),
  'erpWritebackCount', (
    SELECT count(*)::integer FROM actions.intents
    WHERE tenant_id = :'tenant_id'::uuid
      AND created_at BETWEEN :'started_at'::timestamptz AND :'completed_at'::timestamptz
      AND target_system ILIKE '%erp%'
      AND (idempotency_key LIKE 'p1-si-%' OR payload->>'source' = 'strategic-intelligence')
  ),
  'socialWritebackCount', (
    SELECT count(*)::integer FROM actions.intents
    WHERE tenant_id = :'tenant_id'::uuid
      AND created_at BETWEEN :'started_at'::timestamptz AND :'completed_at'::timestamptz
      AND (target_system ILIKE '%social%' OR target_system ILIKE '%media%')
      AND (idempotency_key LIKE 'p1-si-%' OR payload->>'source' = 'strategic-intelligence')
  ),
  'causalActivationCount', (
    SELECT count(*)::integer FROM strategic_intelligence.impact_hypotheses
    WHERE tenant_id = :'tenant_id'::uuid
      AND recorded_at BETWEEN :'started_at'::timestamptz AND :'completed_at'::timestamptz
      AND activation_status = 'active'
  )
);
SQL
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$output_file"
