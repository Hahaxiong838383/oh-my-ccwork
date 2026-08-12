DELETE FROM knowledge.resources
 WHERE tenant_id = :'tenant_id'::uuid
   AND provider = 'goal7-worker-readback'
   AND external_key = 'goal7-worker-readback-' || :'run_key';

UPDATE iam.principals
   SET status = 'disabled', updated_at = now()
 WHERE tenant_id = :'tenant_id'::uuid
   AND principal_type = 'person'
   AND external_key = 'feishu:goal7-worker-readback';

SELECT 1 / CASE WHEN (
  SELECT count(*)
    FROM knowledge.resources
   WHERE tenant_id = :'tenant_id'::uuid
     AND provider = 'goal7-worker-readback'
     AND external_key = 'goal7-worker-readback-' || :'run_key'
) = 0 THEN 1 ELSE 0 END AS cleanup_verified;
