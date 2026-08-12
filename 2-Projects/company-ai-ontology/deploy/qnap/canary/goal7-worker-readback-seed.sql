DO $$
BEGIN
  IF to_regclass('runtime.h_engine_usage_events') IS NULL THEN
    RAISE EXCEPTION 'Goal 7 migration 012 is not applied';
  END IF;
END
$$;

INSERT INTO iam.principals (
  tenant_id, principal_type, external_key, display_name, department_key, status, attributes
)
VALUES (
  :'tenant_id'::uuid, 'person', 'feishu:goal7-worker-readback',
  'Goal 7 Worker Readback', 'goal7-canary', 'active',
  '{"simulation":true,"fixture":"goal7-worker-readback"}'::jsonb
)
ON CONFLICT (tenant_id, principal_type, external_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  department_key = EXCLUDED.department_key,
  status = 'active',
  attributes = EXCLUDED.attributes,
  updated_at = now();

INSERT INTO knowledge.resources (
  tenant_id, provider, resource_type, external_key, title, classification,
  acl_status, status, metadata, source_updated_at
)
VALUES (
  :'tenant_id'::uuid, 'goal7-worker-readback', 'synthetic',
  'goal7-worker-readback-' || :'run_key',
  'GOAL7_WORKER_READBACK_' || upper(:'run_key'),
  'internal', 'known', 'active',
  '{"simulation":true,"sourceSystem":"goal7-worker-readback"}'::jsonb,
  now()
)
ON CONFLICT (tenant_id, provider, external_key) DO UPDATE SET
  title = EXCLUDED.title,
  classification = 'internal',
  acl_status = 'known',
  status = 'active',
  metadata = EXCLUDED.metadata,
  source_updated_at = now(),
  synced_at = now(),
  updated_at = now();

DELETE FROM knowledge.chunks
 WHERE tenant_id = :'tenant_id'::uuid
   AND resource_id = (
     SELECT id FROM knowledge.resources
      WHERE tenant_id = :'tenant_id'::uuid
        AND provider = 'goal7-worker-readback'
        AND external_key = 'goal7-worker-readback-' || :'run_key'
   );

DELETE FROM knowledge.acl_entries
 WHERE tenant_id = :'tenant_id'::uuid
   AND resource_id = (
     SELECT id FROM knowledge.resources
      WHERE tenant_id = :'tenant_id'::uuid
        AND provider = 'goal7-worker-readback'
        AND external_key = 'goal7-worker-readback-' || :'run_key'
   );

INSERT INTO knowledge.chunks (tenant_id, resource_id, chunk_index, content, token_estimate)
SELECT tenant_id, id, 0,
       'GOAL7_WORKER_READBACK_' || upper(:'run_key') || ' synthetic runtime verification evidence.',
       24
  FROM knowledge.resources
 WHERE tenant_id = :'tenant_id'::uuid
   AND provider = 'goal7-worker-readback'
   AND external_key = 'goal7-worker-readback-' || :'run_key';

INSERT INTO knowledge.acl_entries (tenant_id, resource_id, subject_type, subject_key, permission, source)
SELECT tenant_id, id, 'person', 'feishu:goal7-worker-readback', 'read', 'goal7_worker_readback'
  FROM knowledge.resources
 WHERE tenant_id = :'tenant_id'::uuid
   AND provider = 'goal7-worker-readback'
   AND external_key = 'goal7-worker-readback-' || :'run_key';
