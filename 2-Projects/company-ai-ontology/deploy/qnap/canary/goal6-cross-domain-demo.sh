#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}

cd "$project_root"
set -a
. ./.env
set +a

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" < canary/goal6-cross-domain-demo.sql

node_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM ontology.entities WHERE tenant_id='$FUTURUS_TENANT_ID' AND external_key LIKE 'goal6-demo-%';")
relation_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM ontology.relations relation JOIN ontology.entities source ON source.id=relation.from_entity_id WHERE relation.tenant_id='$FUTURUS_TENANT_ID' AND source.external_key LIKE 'goal6-demo-%';")
decision_status=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT status FROM decision.cases WHERE tenant_id='$FUTURUS_TENANT_ID' AND external_key='goal6-demo-decision-case';")
task_status=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT status FROM workflow.tasks WHERE tenant_id='$FUTURUS_TENANT_ID' AND external_key='goal6-demo-task';")
verification_status=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT attributes->>'status' FROM ontology.entities WHERE tenant_id='$FUTURUS_TENANT_ID' AND entity_type='core.work.Verification' AND external_key='goal6-demo-verification';")
learning_status=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT attributes->>'status' FROM ontology.entities WHERE tenant_id='$FUTURUS_TENANT_ID' AND entity_type='core.work.Learning' AND external_key='goal6-demo-learning';")
actions=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM actions.intents WHERE tenant_id='$FUTURUS_TENANT_ID' AND idempotency_key LIKE 'goal6-demo-%';")
deliveries=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM delivery.outbox WHERE tenant_id='$FUTURUS_TENANT_ID' AND idempotency_key LIKE 'goal6-demo-%';")
audit_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM audit.events WHERE tenant_id='$FUTURUS_TENANT_ID' AND request_id='goal6-cross-domain-readonly-demo';")
source_evidence=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM ontology.entities WHERE tenant_id='$FUTURUS_TENANT_ID' AND external_key IN ('goal6-demo-market-signal','goal6-demo-erp-evidence') AND attributes#>>'{provenance,sourceRecordId}' IS NOT NULL;")

printf 'nodes=%s relations=%s decision=%s task=%s verification=%s learning=%s actions=%s deliveries=%s audit=%s source_evidence=%s\n' \
  "$node_count" "$relation_count" "$decision_status" "$task_status" "$verification_status" "$learning_status" "$actions" "$deliveries" "$audit_count" "$source_evidence"
[ "$node_count" -eq 11 ]
[ "$relation_count" -eq 9 ]
[ "$decision_status" = draft ]
[ "$task_status" = draft ]
[ "$verification_status" = pending ]
[ "$learning_status" = proposed ]
[ "$actions" -eq 0 ]
[ "$deliveries" -eq 0 ]
[ "$audit_count" -ge 12 ]
[ "$source_evidence" -eq 2 ]
