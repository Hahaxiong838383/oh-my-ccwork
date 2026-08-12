DO $$
BEGIN
  IF to_regclass('work.conversation_authority_snapshots') IS NULL THEN
    RAISE EXCEPTION 'Goal 7 migration 012 is not applied';
  END IF;
END
$$;

INSERT INTO iam.principals (
  tenant_id, principal_type, external_key, display_name, department_key, status, attributes
)
VALUES
  (:'tenant_id'::uuid, 'person', 'feishu:goal7-sender-' || :'run_key', 'Goal 7 Synthetic Sender', 'goal7-canary', 'active', '{"simulation":true,"fixture":"goal7-authority"}'::jsonb),
  (:'tenant_id'::uuid, 'person', 'feishu:goal7-mentioned-' || :'run_key', 'Goal 7 Synthetic Mentioned', 'goal7-canary', 'active', '{"simulation":true,"fixture":"goal7-authority"}'::jsonb)
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
VALUES
  (:'tenant_id'::uuid, 'goal7-canary', 'synthetic', 'goal7-' || :'run_key' || '-private', 'GOAL7_' || upper(replace(:'run_key', '-', '_')) || '_PRIVATE', 'internal', 'known', 'active', '{"simulation":true,"sourceSystem":"goal7-authority-canary"}'::jsonb, now()),
  (:'tenant_id'::uuid, 'goal7-canary', 'synthetic', 'goal7-' || :'run_key' || '-chat', 'GOAL7_' || upper(replace(:'run_key', '-', '_')) || '_CHAT', 'internal', 'known', 'active', '{"simulation":true,"sourceSystem":"goal7-authority-canary"}'::jsonb, now()),
  (:'tenant_id'::uuid, 'goal7-canary', 'synthetic', 'goal7-' || :'run_key' || '-mentioned', 'GOAL7_' || upper(replace(:'run_key', '-', '_')) || '_MENTIONED', 'internal', 'known', 'active', '{"simulation":true,"sourceSystem":"goal7-authority-canary"}'::jsonb, now()),
  (:'tenant_id'::uuid, 'goal7-canary', 'synthetic', 'goal7-' || :'run_key' || '-purpose', 'GOAL7_' || upper(replace(:'run_key', '-', '_')) || '_PURPOSE', 'internal', 'known', 'active', '{"simulation":true,"sourceSystem":"goal7-authority-canary","allowedPurposes":["decision_support"]}'::jsonb, now()),
  (:'tenant_id'::uuid, 'goal7-canary', 'synthetic', 'goal7-' || :'run_key' || '-denied', 'GOAL7_' || upper(replace(:'run_key', '-', '_')) || '_DENIED', 'internal', 'known', 'active', '{"simulation":true,"sourceSystem":"goal7-authority-canary"}'::jsonb, now())
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
  AND resource_id IN (
    SELECT id FROM knowledge.resources
    WHERE tenant_id = :'tenant_id'::uuid AND provider = 'goal7-canary' AND external_key LIKE 'goal7-' || :'run_key' || '-%'
  );
DELETE FROM knowledge.acl_entries
WHERE tenant_id = :'tenant_id'::uuid
  AND resource_id IN (
    SELECT id FROM knowledge.resources
    WHERE tenant_id = :'tenant_id'::uuid AND provider = 'goal7-canary' AND external_key LIKE 'goal7-' || :'run_key' || '-%'
  );

INSERT INTO knowledge.chunks (tenant_id, resource_id, chunk_index, content, token_estimate)
SELECT r.tenant_id, r.id, 0, r.title || ' synthetic authority evidence', 16
FROM knowledge.resources r
WHERE r.tenant_id = :'tenant_id'::uuid
  AND r.provider = 'goal7-canary'
  AND r.external_key LIKE 'goal7-' || :'run_key' || '-%';

INSERT INTO knowledge.acl_entries (tenant_id, resource_id, subject_type, subject_key, permission, source)
SELECT r.tenant_id, r.id,
  CASE r.external_key
    WHEN 'goal7-' || :'run_key' || '-chat' THEN 'chat'
    ELSE 'person'
  END,
  CASE r.external_key
    WHEN 'goal7-' || :'run_key' || '-chat' THEN 'oc_goal7_' || :'run_key'
    WHEN 'goal7-' || :'run_key' || '-private' THEN 'feishu:goal7-sender-' || :'run_key'
    WHEN 'goal7-' || :'run_key' || '-purpose' THEN 'feishu:goal7-sender-' || :'run_key'
    ELSE 'feishu:goal7-mentioned-' || :'run_key'
  END,
  'read', 'goal7_authority_canary'
FROM knowledge.resources r
WHERE r.tenant_id = :'tenant_id'::uuid
  AND r.provider = 'goal7-canary'
  AND r.external_key LIKE 'goal7-' || :'run_key' || '-%';
