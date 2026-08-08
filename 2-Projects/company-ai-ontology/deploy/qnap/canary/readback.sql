\set ON_ERROR_STOP on
SELECT set_config('app.tenant_id', :'tenant_id', false);
SELECT 'tasks' AS category, status AS item, count(*)::bigint AS count
FROM workflow.tasks
WHERE external_key LIKE 'demo-p2-2026-001:task:%'
GROUP BY status ORDER BY status;
SELECT 'action' AS category, status AS item, count(*)::bigint AS count
FROM actions.intents
WHERE idempotency_key LIKE 'qnap-p0-e-%'
GROUP BY status ORDER BY status;
SELECT 'retry' AS category, status AS item, attempt_count AS count
FROM delivery.outbox
WHERE idempotency_key = 'canary-retry:' || :'run_id';
SELECT 'artifacts' AS category, 'all' AS item, count(*)::bigint AS count
FROM evidence.artifacts
WHERE object_uri LIKE 'demo://task/demo-p2-2026-001:%';
