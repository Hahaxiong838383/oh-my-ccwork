#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
run_id=${1:?usage: retire-goal5-attempt.sh GOAL5_RUN_ID}
p2_external_key=${GOAL5_P2_EXTERNAL_KEY:-company-ai-ontology-goal5-$run_id}
decision_external_key=$p2_external_key-decision-$run_id

case "$run_id:$p2_external_key" in
  *[!A-Za-z0-9:_-]*) echo 'invalid Goal 5 identifier' >&2; exit 2 ;;
esac

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ -d "$project_root" ] || { echo 'company ontology project root missing' >&2; exit 1; }

cd "$project_root"
set -a
. ./.env
set +a

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" \
  --set=run_id="$run_id" \
  --set=p2_external_key="$p2_external_key" \
  --set=decision_external_key="$decision_external_key" <<'SQL'
BEGIN;

SELECT EXISTS (
  SELECT 1
    FROM decision.practice_status_v1
   WHERE tenant_id=:'tenant_id'::uuid
     AND decision_case_external_key=:'decision_external_key'
     AND practice_status='goal_verified'
) AS lineage_verified \gset

\if :lineage_verified
  \echo 'refusing to retire a goal_verified lineage'
  \quit 3
\endif

UPDATE decision.decisions decision
   SET status='superseded', updated_at=now()
  FROM decision.cases decision_case
 WHERE decision.tenant_id=:'tenant_id'::uuid
   AND decision_case.tenant_id=decision.tenant_id
   AND decision_case.id=decision.decision_case_id
   AND decision_case.external_key=:'decision_external_key'
   AND decision.status='approved';

UPDATE decision.cases
   SET status='superseded', updated_at=now()
 WHERE tenant_id=:'tenant_id'::uuid
   AND external_key=:'decision_external_key'
   AND status NOT IN ('rejected', 'superseded', 'closed');

UPDATE ontology.entities
   SET attributes=attributes || jsonb_build_object(
         'canaryAttemptStatus', 'retired',
         'canaryRunId', :'run_id'::text
       ),
       updated_at=now()
 WHERE tenant_id=:'tenant_id'::uuid
   AND entity_type='p2'
   AND external_key=:'p2_external_key';

WITH target_case AS (
  SELECT tenant_id, id, status AS from_status
    FROM work.brain_cases
   WHERE tenant_id=:'tenant_id'::uuid
     AND external_case_id='workcase:' || :'run_id' || '-decision-propose'
     AND status <> 'completed'
), retired_case AS (
  UPDATE work.brain_cases brain_case
     SET status='blocked', updated_at=now()
    FROM target_case
   WHERE brain_case.tenant_id=target_case.tenant_id
     AND brain_case.id=target_case.id
  RETURNING target_case.tenant_id, target_case.id, target_case.from_status
)
INSERT INTO work.brain_case_events (
  tenant_id, case_id, event_type, from_status, to_status, idempotency_key, payload
)
SELECT tenant_id, id, 'canary_attempt_retired', from_status, 'blocked',
       :'run_id' || '-retired',
       jsonb_build_object('simulation', true, 'reason', 'failed-production-canary-attempt')
  FROM retired_case
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;

COMMIT;

SELECT coalesce(decision_case_external_key, 'no-decision') AS decision_case,
       practice_status,
       task_count,
       action_count,
       verification_count,
       learning_count
  FROM decision.practice_status_v1
 WHERE tenant_id=:'tenant_id'::uuid
   AND decision_case_external_key=:'decision_external_key';
SQL
