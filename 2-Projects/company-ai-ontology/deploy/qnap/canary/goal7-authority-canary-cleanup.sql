DELETE FROM audit.events
WHERE tenant_id = :'tenant_id'::uuid
  AND request_id LIKE 'goal7-canary-' || :'run_key' || '-%';

DELETE FROM work.conversation_authority_snapshots
WHERE tenant_id = :'tenant_id'::uuid
  AND request_principal_external_key IN (
    'feishu:goal7-sender-' || :'run_key',
    'feishu:goal7-mentioned-' || :'run_key'
  );

DELETE FROM knowledge.resources
WHERE tenant_id = :'tenant_id'::uuid
  AND provider = 'goal7-canary'
  AND external_key LIKE 'goal7-' || :'run_key' || '-%';

DELETE FROM iam.principals
WHERE tenant_id = :'tenant_id'::uuid
  AND principal_type = 'person'
  AND external_key IN (
    'feishu:goal7-sender-' || :'run_key',
    'feishu:goal7-mentioned-' || :'run_key'
  );

SELECT 1 / CASE WHEN (
  (SELECT count(*) FROM audit.events
    WHERE tenant_id = :'tenant_id'::uuid AND request_id LIKE 'goal7-canary-' || :'run_key' || '-%')
  + (SELECT count(*) FROM work.conversation_authority_snapshots
    WHERE tenant_id = :'tenant_id'::uuid
      AND request_principal_external_key IN ('feishu:goal7-sender-' || :'run_key', 'feishu:goal7-mentioned-' || :'run_key'))
  + (SELECT count(*) FROM knowledge.resources
    WHERE tenant_id = :'tenant_id'::uuid AND provider = 'goal7-canary' AND external_key LIKE 'goal7-' || :'run_key' || '-%')
  + (SELECT count(*) FROM iam.principals
    WHERE tenant_id = :'tenant_id'::uuid
      AND principal_type = 'person'
      AND external_key IN ('feishu:goal7-sender-' || :'run_key', 'feishu:goal7-mentioned-' || :'run_key'))
) = 0 THEN 1 ELSE 0 END AS cleanup_verified;
