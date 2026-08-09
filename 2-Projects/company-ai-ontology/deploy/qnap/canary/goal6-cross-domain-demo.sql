\set ON_ERROR_STOP on

SELECT set_config('app.tenant_id', :'tenant_id', false);

INSERT INTO iam.principals (tenant_id, principal_type, external_key, display_name, department_key, status, attributes)
VALUES (:'tenant_id'::uuid, 'person', 'goal6-domain-demo-dri', 'Goal 6 Domain Demo DRI', 'ontology-validation', 'active', '{"simulation":true}'::jsonb)
ON CONFLICT (tenant_id, principal_type, external_key) DO NOTHING;

INSERT INTO work.brain_cases (
  tenant_id, external_case_id, principal_id, principal_external_key, purpose, work_mode,
  request_summary, request_fingerprint, requested_outcome, status, risk_level,
  policy_snapshot_id, policy_snapshot, ontology_version_id, protocol_version,
  processing_mode, evidence_count, confidence_level, deterministic_conclusion_allowed,
  response_validation_status
)
SELECT
  :'tenant_id'::uuid, 'goal6-cross-domain-readonly-demo', principal.id,
  principal.external_key, 'goal6-cross-domain-readonly-validation', 'decision_support',
  'Use a normalized market signal and ERP evidence to prepare a governed product task proposal.',
  encode(digest('goal6-cross-domain-readonly-demo', 'sha256'), 'hex'),
  'Produce a draft-only decision and task lineage without business writeback.',
  'review_required', 'medium', 'goal6-readonly-policy',
  '{"authority":"ontology-owner","writeback":false,"employeeDelivery":false}'::jsonb,
  version.id, '1.1.0', 'active', 2, 'medium', false, 'valid'
FROM iam.principals principal
JOIN ontology_registry.versions version ON version.tenant_id=principal.tenant_id AND version.status='active'
WHERE principal.tenant_id=:'tenant_id'::uuid AND principal.external_key='goal6-domain-demo-dri'
ON CONFLICT (tenant_id, external_case_id) DO UPDATE SET
  status=EXCLUDED.status, evidence_count=EXCLUDED.evidence_count,
  confidence_level=EXCLUDED.confidence_level,
  deterministic_conclusion_allowed=EXCLUDED.deterministic_conclusion_allowed,
  updated_at=now();

WITH version AS (
  SELECT id FROM ontology_registry.versions WHERE tenant_id=:'tenant_id'::uuid AND status='active'
), market_record AS (
  SELECT id, external_id, object_type, source_system, source_updated_at, status
  FROM domain_read.records
  WHERE tenant_id=:'tenant_id'::uuid AND source_system='kidshub-market' AND object_type='domain.market.MarketSignal' AND status='active'
  ORDER BY source_updated_at DESC, id LIMIT 1
), erp_record AS (
  SELECT id, external_id, object_type, source_system, source_updated_at, status
  FROM domain_read.records
  WHERE tenant_id=:'tenant_id'::uuid AND source_system='aishike-erp-m3' AND object_type='domain.operations.FulfillmentEvidence' AND status='active'
  ORDER BY source_updated_at DESC, id LIMIT 1
), node_values(entity_type, external_key, display_name, attributes) AS (
  SELECT 'domain.market.MarketSignal', 'goal6-demo-market-signal', 'Goal 6 Market Signal',
         jsonb_build_object('status','active','buildState','accepted','authority','kidshub-market','purpose','market-intelligence','provenance',jsonb_build_object('sourceSystem',source_system,'sourceRecordId',id,'sourceExternalId',external_id,'sourceUpdatedAt',source_updated_at))
  FROM market_record
  UNION ALL SELECT 'core.epistemic.Evidence', 'goal6-demo-market-evidence', 'Goal 6 Market Evidence',
         jsonb_build_object('status','admissible','buildState','accepted','authority','data-steward','purpose','decision-support','sourceReference','goal6-demo-market-signal')
  UNION ALL SELECT 'core.epistemic.Claim', 'goal6-demo-claim', 'Goal 6 Market Claim',
         jsonb_build_object('status','qualified','buildState','accepted','authority','evidence-owner','purpose','decision-support','epistemicType','derived_fact','confidence','medium')
  UNION ALL SELECT 'core.decision.DecisionCase', 'goal6-demo-decision-case', 'Goal 6 Decision Case',
         jsonb_build_object('status','draft','buildState','proposal','authority','goal6-domain-demo-dri','purpose','product-prioritization','writeback',false)
  UNION ALL SELECT 'domain.product.ProductVersion', 'goal6-demo-product-version', 'Goal 6 Product Version Candidate',
         jsonb_build_object('status','draft','buildState','proposal','authority','domain-owner','purpose','product-evaluation','versionKey','goal6-candidate-v1')
  UNION ALL SELECT 'core.work.Goal', 'goal6-demo-goal', 'Goal 6 Draft Goal',
         jsonb_build_object('status','draft','buildState','proposal','authority','goal-owner','purpose','controlled-demo','targetProductVersion','goal6-demo-product-version')
  UNION ALL SELECT 'core.work.P2', 'goal6-demo-p2', 'Goal 6 Draft P2',
         jsonb_build_object('status','draft','buildState','proposal','authority','p2-owner','purpose','controlled-demo','employeeDelivery',false)
  UNION ALL SELECT 'core.work.Task', 'goal6-demo-task', 'Goal 6 Draft Task Proposal',
         jsonb_build_object('status','draft','buildState','proposal','authority','goal6-domain-demo-dri','purpose','controlled-demo','businessWriteback',false)
  UNION ALL SELECT 'domain.operations.FulfillmentEvidence', 'goal6-demo-erp-evidence', 'Goal 6 ERP Fulfillment Evidence',
         jsonb_build_object('status','active','buildState','accepted','authority','aishike-erp-m3','purpose','operations-read-model','provenance',jsonb_build_object('sourceSystem',source_system,'sourceRecordId',id,'sourceExternalId',external_id,'sourceUpdatedAt',source_updated_at))
  FROM erp_record
  UNION ALL SELECT 'core.work.Verification', 'goal6-demo-verification', 'Goal 6 Pending Verification',
         jsonb_build_object('status','pending','buildState','proposal','authority','verification-owner','purpose','controlled-demo','executionStatus','unknown','businessProcessStatus','unknown','goalStatus','unknown')
  UNION ALL SELECT 'core.work.Learning', 'goal6-demo-learning', 'Goal 6 Proposed Learning',
         jsonb_build_object('status','proposed','buildState','proposal','authority','domain-owner','purpose','controlled-demo','autoApply',false)
)
INSERT INTO ontology.entities (
  tenant_id, entity_type, external_key, display_name, classification, attributes,
  ontology_version_id, schema_version, security_domain, lifecycle_status,
  source_system, source_reference
)
SELECT :'tenant_id'::uuid, node.entity_type, node.external_key, node.display_name, 'internal', node.attributes,
       version.id, '3.3.0', 'company', COALESCE(node.attributes->>'status','active'),
       COALESCE(node.attributes#>>'{provenance,sourceSystem}','company-brain'),
       COALESCE(node.attributes#>>'{provenance,sourceRecordId}',node.external_key)
FROM node_values node CROSS JOIN version
ON CONFLICT (tenant_id, entity_type, external_key) DO UPDATE SET
  display_name=EXCLUDED.display_name, attributes=EXCLUDED.attributes,
  ontology_version_id=EXCLUDED.ontology_version_id, schema_version=EXCLUDED.schema_version,
  lifecycle_status=EXCLUDED.lifecycle_status, source_system=EXCLUDED.source_system,
  source_reference=EXCLUDED.source_reference, updated_at=now();

INSERT INTO decision.cases (
  tenant_id, external_key, work_case_id, question_summary, purpose, risk_level,
  status, dri_id, evidence_package_id, ontology_version_id
)
SELECT :'tenant_id'::uuid, 'goal6-demo-decision-case', work_case.id,
       'Should the selected market signal become a product-version and P2 task proposal?',
       'goal6-cross-domain-readonly-validation', 'medium', 'draft', principal.id,
       'evidence:goal6-domain-readonly-v1', version.id
FROM work.brain_cases work_case
JOIN iam.principals principal ON principal.tenant_id=work_case.tenant_id AND principal.external_key='goal6-domain-demo-dri'
JOIN ontology_registry.versions version ON version.tenant_id=work_case.tenant_id AND version.status='active'
WHERE work_case.tenant_id=:'tenant_id'::uuid AND work_case.external_case_id='goal6-cross-domain-readonly-demo'
ON CONFLICT (tenant_id, external_key) DO UPDATE SET
  status='draft', evidence_package_id=EXCLUDED.evidence_package_id, updated_at=now();

INSERT INTO workflow.tasks (
  tenant_id, external_key, source_entity_id, dri_id, title, description,
  acceptance_criteria, status, priority
)
SELECT :'tenant_id'::uuid, 'goal6-demo-task', p2.id, principal.id,
       'Evaluate the Goal 6 product-version proposal',
       'Controlled draft only. Do not deliver to employees or write back to business systems.',
       '[{"criterion":"Human approver reviews the market and ERP evidence"},{"criterion":"No external writeback occurs"}]'::jsonb,
       'draft', 'P2'
FROM ontology.entities p2
JOIN iam.principals principal ON principal.tenant_id=p2.tenant_id AND principal.external_key='goal6-domain-demo-dri'
WHERE p2.tenant_id=:'tenant_id'::uuid AND p2.entity_type='core.work.P2' AND p2.external_key='goal6-demo-p2'
ON CONFLICT (tenant_id, external_key) WHERE external_key IS NOT NULL DO UPDATE SET
  status='draft', approved_by=NULL, approved_at=NULL, updated_at=now();

WITH links(relation_type, from_key, to_key, attributes) AS (
  VALUES
    ('domain.market.INDICATES', 'goal6-demo-market-signal', 'goal6-demo-market-evidence', '{"purpose":"evidence-formation"}'::jsonb),
    ('core.epistemic.SUPPORTS', 'goal6-demo-market-evidence', 'goal6-demo-claim', '{"purpose":"claim-support"}'::jsonb),
    ('core.epistemic.INFLUENCES_DECISION_CASE', 'goal6-demo-claim', 'goal6-demo-decision-case', '{"purpose":"decision-support"}'::jsonb),
    ('core.decision.PRIORITIZES_VERSION', 'goal6-demo-decision-case', 'goal6-demo-product-version', '{"status":"proposal"}'::jsonb),
    ('core.work.GOAL_DECOMPOSES_TO', 'goal6-demo-goal', 'goal6-demo-p2', '{"status":"draft"}'::jsonb),
    ('core.work.DECOMPOSES_TO', 'goal6-demo-p2', 'goal6-demo-task', '{"status":"draft"}'::jsonb),
    ('core.work.USES_EVIDENCE', 'goal6-demo-task', 'goal6-demo-erp-evidence', '{"purpose":"operations-verification"}'::jsonb),
    ('core.work.VERIFIED_BY', 'goal6-demo-task', 'goal6-demo-verification', '{"status":"pending"}'::jsonb),
    ('core.work.PRODUCES_LEARNING', 'goal6-demo-verification', 'goal6-demo-learning', '{"status":"proposed"}'::jsonb)
)
INSERT INTO ontology.relations (tenant_id, relation_type, from_entity_id, to_entity_id, attributes)
SELECT :'tenant_id'::uuid, links.relation_type, source.id, target.id,
       links.attributes || jsonb_build_object('authority','ontology-owner','purpose',COALESCE(links.attributes->>'purpose','controlled-demo'),'provenance','goal6-cross-domain-readonly-demo')
FROM links
JOIN ontology.entities source ON source.tenant_id=:'tenant_id'::uuid AND source.external_key=links.from_key
JOIN ontology.entities target ON target.tenant_id=:'tenant_id'::uuid AND target.external_key=links.to_key
ON CONFLICT (tenant_id, relation_type, from_entity_id, to_entity_id) DO UPDATE SET attributes=EXCLUDED.attributes;

INSERT INTO audit.events (tenant_id, actor_service, event_type, resource_type, resource_id, request_id, payload)
SELECT entity.tenant_id, 'company-domain-demo', 'goal6_cross_domain_node_recorded', entity.entity_type,
       entity.external_key, 'goal6-cross-domain-readonly-demo',
       jsonb_build_object('authority',entity.attributes->>'authority','purpose',entity.attributes->>'purpose','status',entity.attributes->>'status','writeback',false)
FROM ontology.entities entity
WHERE entity.tenant_id=:'tenant_id'::uuid AND entity.external_key LIKE 'goal6-demo-%'
  AND NOT EXISTS (
    SELECT 1 FROM audit.events event
    WHERE event.tenant_id=entity.tenant_id AND event.event_type='goal6_cross_domain_node_recorded'
      AND event.resource_type=entity.entity_type AND event.resource_id=entity.external_key
  );

INSERT INTO audit.events (tenant_id, actor_service, event_type, resource_type, resource_id, request_id, payload)
SELECT :'tenant_id'::uuid, 'company-domain-demo', 'goal6_cross_domain_task_proposed', 'workflow.task', task.external_key,
       'goal6-cross-domain-readonly-demo', '{"authority":"goal6-domain-demo-dri","purpose":"controlled-demo","employeeDelivery":false,"writeback":false}'::jsonb
FROM workflow.tasks task
WHERE task.tenant_id=:'tenant_id'::uuid AND task.external_key='goal6-demo-task'
  AND NOT EXISTS (
    SELECT 1 FROM audit.events event
    WHERE event.tenant_id=task.tenant_id AND event.event_type='goal6_cross_domain_task_proposed' AND event.resource_id=task.external_key
  );
