ALTER TABLE workflow.tasks ADD COLUMN IF NOT EXISTS external_key text;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_key_idx
  ON workflow.tasks (tenant_id, external_key)
  WHERE external_key IS NOT NULL;

INSERT INTO iam.principals (
  tenant_id, principal_type, external_key, display_name, department_key, attributes
)
SELECT
  :'tenant_id'::uuid,
  'person',
  'demo-person-' || lpad(number::text, 2, '0'),
  '演示员工 ' || lpad(number::text, 2, '0'),
  CASE WHEN number <= 5 THEN 'product' ELSE 'operations' END,
  jsonb_build_object('simulation', true, 'employee_number', number)
FROM generate_series(1, 10) AS number
ON CONFLICT (tenant_id, principal_type, external_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  department_key = EXCLUDED.department_key,
  attributes = EXCLUDED.attributes,
  updated_at = now();
INSERT INTO iam.principals (
  tenant_id, principal_type, external_key, display_name, department_key, attributes
)
VALUES (
  :'tenant_id'::uuid,
  'person',
  'demo-dri-01',
  '演示 DRI',
  'management',
  '{"simulation":true,"role":"dri"}'::jsonb
)
ON CONFLICT (tenant_id, principal_type, external_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  department_key = EXCLUDED.department_key,
  attributes = EXCLUDED.attributes,
  updated_at = now();

INSERT INTO iam.grants (tenant_id, principal_id, resource_scope, permission, constraints)
SELECT :'tenant_id'::uuid, id, 'ontology:classification:internal', 'read', '{"simulation":true}'::jsonb
FROM iam.principals
WHERE tenant_id = :'tenant_id'::uuid
  AND external_key LIKE 'demo-%'
ON CONFLICT (tenant_id, principal_id, resource_scope, permission) DO NOTHING;

INSERT INTO iam.grants (tenant_id, principal_id, resource_scope, permission, constraints)
SELECT :'tenant_id'::uuid, id, 'workflow:task:self', 'write', '{"simulation":true}'::jsonb
FROM iam.principals
WHERE tenant_id = :'tenant_id'::uuid
  AND external_key LIKE 'demo-person-%'
ON CONFLICT (tenant_id, principal_id, resource_scope, permission) DO NOTHING;

INSERT INTO iam.grants (tenant_id, principal_id, resource_scope, permission, constraints)
SELECT :'tenant_id'::uuid, id, 'ontology:classification:restricted', 'read', '{"simulation":true}'::jsonb
FROM iam.principals
WHERE tenant_id = :'tenant_id'::uuid
  AND external_key = 'demo-dri-01'
ON CONFLICT (tenant_id, principal_id, resource_scope, permission) DO NOTHING;

INSERT INTO iam.grants (tenant_id, principal_id, resource_scope, permission, constraints)
SELECT :'tenant_id'::uuid, id, 'workflow:p2', 'approve', '{"simulation":true}'::jsonb
FROM iam.principals
WHERE tenant_id = :'tenant_id'::uuid
  AND external_key = 'demo-dri-01'
ON CONFLICT (tenant_id, principal_id, resource_scope, permission) DO NOTHING;

INSERT INTO ontology.entities (
  tenant_id, entity_type, external_key, display_name, classification, attributes, created_by
)
SELECT
  :'tenant_id'::uuid,
  seed.entity_type,
  seed.external_key,
  seed.display_name,
  seed.classification,
  seed.attributes,
  dri.id
FROM (
  VALUES
    ('policy', 'demo-company-handbook', '公司员工协作手册', 'public', '{"simulation":true,"summary":"公司任务协作统一通过公司级 Bot，私人 Bot 保持独立。"}'::jsonb),
    ('p2', 'demo-p2-2026-001', 'P2：完成公司 AI Ontology 十人演示闭环', 'internal', '{"simulation":true,"department_key":"product","summary":"完成 H 引擎、权限检索、任务下发、成果提交和 DRI 验收。"}'::jsonb),
    ('roadmap', 'demo-product-roadmap', '产品路线图演示数据', 'confidential', '{"simulation":true,"department_key":"product","summary":"仅授权人员可读取的产品路线图。"}'::jsonb),
    ('budget', 'demo-management-budget', '经营预算演示数据', 'restricted', '{"simulation":true,"department_key":"management","summary":"仅 DRI 可读取的受限预算演示数据。"}'::jsonb)
) AS seed(entity_type, external_key, display_name, classification, attributes)
CROSS JOIN LATERAL (
  SELECT id FROM iam.principals
  WHERE tenant_id = :'tenant_id'::uuid AND external_key = 'demo-dri-01'
  LIMIT 1
) AS dri
ON CONFLICT (tenant_id, entity_type, external_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  classification = EXCLUDED.classification,
  attributes = EXCLUDED.attributes,
  updated_at = now();
