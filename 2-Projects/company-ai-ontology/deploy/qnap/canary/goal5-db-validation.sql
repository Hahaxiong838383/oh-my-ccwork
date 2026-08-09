\set ON_ERROR_STOP on

SELECT set_config('app.tenant_id', :'tenant_id', false);

INSERT INTO ontology_registry.versions (
  tenant_id, schema_version, version_tag, content_hash, source_commit,
  compatibility, status, proposal_id, approved_by_external_key,
  migration_plan, definition, deployed_at
) VALUES (
  :'tenant_id'::uuid, '3.2.0', 'goal5-validation', repeat('a', 64), 'abcdef1',
  'bootstrap', 'active', 'goal5-validation', 'validation-owner',
  '{}'::jsonb, '{}'::jsonb, now()
) ON CONFLICT (tenant_id, version_tag) DO NOTHING;

INSERT INTO iam.principals (tenant_id, principal_type, external_key, display_name, department_key, status)
VALUES
  (:'tenant_id'::uuid, 'person', 'goal5-dri', 'Goal 5 DRI', 'validation', 'active'),
  (:'tenant_id'::uuid, 'person', 'goal5-non-dri', 'Goal 5 Non DRI', 'validation', 'active'),
  (:'tenant_id'::uuid, 'person', 'goal5-assignee-1', 'Goal 5 Assignee 1', 'validation', 'active'),
  (:'tenant_id'::uuid, 'person', 'goal5-assignee-2', 'Goal 5 Assignee 2', 'validation', 'active')
ON CONFLICT (tenant_id, principal_type, external_key) DO NOTHING;

INSERT INTO iam.grants (tenant_id, principal_id, resource_scope, permission)
SELECT :'tenant_id'::uuid, id, 'workflow:p2', 'approve'
  FROM iam.principals
 WHERE tenant_id=:'tenant_id'::uuid AND external_key IN ('goal5-dri', 'goal5-non-dri')
ON CONFLICT (tenant_id, principal_id, resource_scope, permission) DO NOTHING;

INSERT INTO ontology.entities (
  tenant_id, entity_type, external_key, display_name, classification, attributes, ontology_version_id
)
SELECT :'tenant_id'::uuid, 'p2', 'goal5-p2', 'Goal 5 Decision Practice Loop', 'internal',
       jsonb_build_object('simulation', true, 'decision_case_external_key', 'goal5-decision'), v.id
  FROM ontology_registry.versions v
 WHERE v.tenant_id=:'tenant_id'::uuid AND v.status='active'
ON CONFLICT (tenant_id, entity_type, external_key) DO NOTHING;

INSERT INTO decision.cases (
  tenant_id, external_key, question_summary, purpose, risk_level, status, dri_id, evidence_package_id, ontology_version_id
)
SELECT :'tenant_id'::uuid, 'goal5-decision', 'How should Goal 5 be completed?', 'goal5-validation',
       'high', 'pending_approval', dri.id, 'evidence:goal5-validation', version.id
  FROM iam.principals dri
  JOIN ontology_registry.versions version ON version.tenant_id=dri.tenant_id AND version.status='active'
 WHERE dri.tenant_id=:'tenant_id'::uuid AND dri.external_key='goal5-dri'
ON CONFLICT (tenant_id, external_key) DO NOTHING;

INSERT INTO decision.alternatives (
  tenant_id, decision_case_id, external_key, title, expected_outcome, risks, status, ontology_version_id
)
SELECT :'tenant_id'::uuid, decision_case.id, 'goal5-decision:alternative:1', 'Execute governed practice loop',
       jsonb_build_object('metricKey', 'goal5_acceptance', 'targetOperator', 'status', 'targetText', 'accepted'),
       '[]'::jsonb, 'candidate', version.id
  FROM decision.cases decision_case
  JOIN ontology_registry.versions version ON version.tenant_id=decision_case.tenant_id AND version.status='active'
 WHERE decision_case.tenant_id=:'tenant_id'::uuid AND decision_case.external_key='goal5-decision'
ON CONFLICT (tenant_id, decision_case_id, external_key) DO NOTHING;

DO $$
BEGIN
  BEGIN
    INSERT INTO decision.decisions (
      tenant_id, decision_case_id, external_key, selected_alternative_id,
      rationale_summary, status, approved_by, approval_evidence_references, ontology_version_id
    )
    SELECT platform.current_tenant_id(), decision_case.id, 'goal5-decision:invalid', alternative.id,
           'invalid non DRI approval', 'approved', non_dri.id, '["evidence:invalid"]'::jsonb, version.id
      FROM decision.cases decision_case
      JOIN decision.alternatives alternative ON alternative.tenant_id=decision_case.tenant_id AND alternative.decision_case_id=decision_case.id
      JOIN iam.principals non_dri ON non_dri.tenant_id=decision_case.tenant_id AND non_dri.external_key='goal5-non-dri'
      JOIN ontology_registry.versions version ON version.tenant_id=decision_case.tenant_id AND version.status='active'
     WHERE decision_case.tenant_id=platform.current_tenant_id() AND decision_case.external_key='goal5-decision';
    RAISE EXCEPTION 'non DRI decision approval unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;

SET ROLE ontology_app;
SELECT set_config('app.tenant_id', :'tenant_id', false);

INSERT INTO decision.decisions (
  tenant_id, decision_case_id, external_key, selected_alternative_id,
  rationale_summary, status, approved_by, approval_evidence_references, ontology_version_id
)
SELECT :'tenant_id'::uuid, decision_case.id, 'goal5-decision:approved', alternative.id,
       'DRI approved governed Goal 5 practice loop', 'approved', dri.id,
       '["evidence:goal5-validation"]'::jsonb, version.id
  FROM decision.cases decision_case
  JOIN decision.alternatives alternative ON alternative.tenant_id=decision_case.tenant_id AND alternative.decision_case_id=decision_case.id
  JOIN iam.principals dri ON dri.tenant_id=decision_case.tenant_id AND dri.external_key='goal5-dri'
  JOIN ontology_registry.versions version ON version.tenant_id=decision_case.tenant_id AND version.status='active'
 WHERE decision_case.tenant_id=:'tenant_id'::uuid AND decision_case.external_key='goal5-decision'
ON CONFLICT (tenant_id, decision_case_id) DO NOTHING;

UPDATE decision.cases SET status='approved', updated_at=now()
 WHERE tenant_id=:'tenant_id'::uuid AND external_key='goal5-decision';

INSERT INTO decision.expected_outcomes (
  tenant_id, decision_id, owner_type, owner_reference, metric_key, target_operator,
  target_text, acceptance_criteria, status, ontology_version_id
)
SELECT :'tenant_id'::uuid, decision.id, 'p2', 'goal5-p2', 'goal5_acceptance', 'status',
       'accepted', '["decision lineage complete","three result levels verified"]'::jsonb,
       'active', version.id
  FROM decision.decisions decision
  JOIN ontology_registry.versions version ON version.tenant_id=decision.tenant_id AND version.status='active'
 WHERE decision.tenant_id=:'tenant_id'::uuid AND decision.external_key='goal5-decision:approved'
ON CONFLICT (tenant_id, decision_id, owner_type, owner_reference, metric_key) DO NOTHING;

INSERT INTO decision.p2_bindings (tenant_id, decision_id, p2_entity_id, expected_outcome_id)
SELECT :'tenant_id'::uuid, decision.id, p2.id, outcome.id
  FROM decision.decisions decision
  JOIN ontology.entities p2 ON p2.tenant_id=decision.tenant_id AND p2.external_key='goal5-p2'
  JOIN decision.expected_outcomes outcome ON outcome.tenant_id=decision.tenant_id AND outcome.decision_id=decision.id
 WHERE decision.tenant_id=:'tenant_id'::uuid AND decision.external_key='goal5-decision:approved'
ON CONFLICT (tenant_id, p2_entity_id) DO NOTHING;

DO $$
BEGIN
  BEGIN
    INSERT INTO workflow.tasks (tenant_id, external_key, source_entity_id, title, priority)
    SELECT platform.current_tenant_id(), 'goal5-invalid-task', p2_entity_id, 'Invalid P2 task', 'P2'
      FROM decision.p2_bindings WHERE tenant_id=platform.current_tenant_id();
    RAISE EXCEPTION 'P2 task without approved decision unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

INSERT INTO workflow.tasks (
  tenant_id, external_key, source_entity_id, assignee_id, dri_id, title, description,
  acceptance_criteria, status, priority, decision_id, expected_outcome_id
)
SELECT :'tenant_id'::uuid, 'goal5-task-' || assignee.external_key, binding.p2_entity_id,
       assignee.id, decision.approved_by, 'Execute Goal 5 task for ' || assignee.display_name,
       'Decision-bound validation task', '["submit evidence"]'::jsonb, 'accepted', 'P2',
       decision.id, binding.expected_outcome_id
  FROM decision.decisions decision
  JOIN decision.p2_bindings binding ON binding.tenant_id=decision.tenant_id AND binding.decision_id=decision.id
  JOIN iam.principals assignee ON assignee.tenant_id=decision.tenant_id
   AND assignee.external_key IN ('goal5-assignee-1','goal5-assignee-2')
 WHERE decision.tenant_id=:'tenant_id'::uuid AND decision.external_key='goal5-decision:approved'
ON CONFLICT (tenant_id, external_key) WHERE external_key IS NOT NULL DO NOTHING;

INSERT INTO actions.intents (
  tenant_id, requester_id, target_system, action_type, payload, risk_level, status,
  approval_required, approved_by, approved_at, readback_receipt, idempotency_key,
  decision_id, task_id, expected_outcome_id
)
SELECT :'tenant_id'::uuid, decision.approved_by, 'feishu-demo', 'feishu_task_status_demo',
       jsonb_build_object('taskExternalKey', task.external_key, 'desiredStatus', 'done', 'simulation', true),
       'low', 'verified', true, decision.approved_by, now(), '{"verified":true}'::jsonb,
       'goal5-action-' || task.external_key, decision.id, task.id, task.expected_outcome_id
  FROM workflow.tasks task
  JOIN decision.decisions decision ON decision.tenant_id=task.tenant_id AND decision.id=task.decision_id
 WHERE task.tenant_id=:'tenant_id'::uuid AND task.external_key LIKE 'goal5-task-%'
ON CONFLICT (tenant_id, target_system, idempotency_key) DO NOTHING;

RESET ROLE;
SET ROLE action_gateway;
SELECT set_config('app.tenant_id', :'tenant_id', false);

SELECT count(*) AS active_registry_versions_visible
  FROM ontology_registry.versions WHERE tenant_id=:'tenant_id'::uuid AND status='active';

INSERT INTO decision.observed_outcomes (
  tenant_id, expected_outcome_id, source_system, source_reference, observed_text,
  observed_status, evidence_references, confidence_level, observed_at, ontology_version_id
)
SELECT :'tenant_id'::uuid, action.expected_outcome_id, 'goal5-validation', action.id::text,
       'Goal 5 governed task completed', 'met', jsonb_build_array('evidence:' || action.id::text),
       'high', now(), version.id
  FROM actions.intents action
  JOIN ontology_registry.versions version ON version.tenant_id=action.tenant_id AND version.status='active'
 WHERE action.tenant_id=:'tenant_id'::uuid AND action.idempotency_key LIKE 'goal5-action-%';

DO $$
DECLARE
  action_row actions.intents%ROWTYPE;
  observed_id uuid;
  verifier_id uuid;
BEGIN
  SELECT * INTO action_row FROM actions.intents
   WHERE tenant_id=platform.current_tenant_id() AND idempotency_key LIKE 'goal5-action-%' ORDER BY id LIMIT 1;
  SELECT id INTO observed_id FROM decision.observed_outcomes
   WHERE tenant_id=platform.current_tenant_id() AND source_reference=action_row.id::text;
  SELECT id INTO verifier_id FROM iam.principals
   WHERE tenant_id=platform.current_tenant_id() AND external_key='goal5-dri';
  BEGIN
    INSERT INTO decision.verifications (
      tenant_id, decision_id, task_id, action_intent_id, expected_outcome_id, observed_outcome_id,
      execution_success, operational_success, goal_success,
      execution_status, operational_status, goal_status,
      evidence_references, verification_status, verified_by, ontology_version_id
    ) VALUES (
      platform.current_tenant_id(), action_row.decision_id, action_row.task_id, action_row.id,
      action_row.expected_outcome_id, observed_id, true, false, true,
      'success', 'failure', 'achieved', '["evidence:invalid-levels"]'::jsonb,
      'completed', verifier_id, (SELECT id FROM ontology_registry.versions WHERE tenant_id=platform.current_tenant_id() AND status='active')
    );
    RAISE EXCEPTION 'goal success without operational success unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

INSERT INTO decision.verifications (
  tenant_id, decision_id, task_id, action_intent_id, expected_outcome_id, observed_outcome_id,
  execution_success, operational_success, goal_success,
  execution_status, operational_status, goal_status,
  evidence_references, verification_status, verified_by, ontology_version_id
)
SELECT :'tenant_id'::uuid, action.decision_id, action.task_id, action.id, action.expected_outcome_id,
       observed.id, true, true, true, 'success', 'success', 'achieved',
       jsonb_build_array('evidence:' || action.id::text), 'completed', dri.id, version.id
  FROM actions.intents action
  JOIN decision.observed_outcomes observed ON observed.tenant_id=action.tenant_id AND observed.source_reference=action.id::text
  JOIN iam.principals dri ON dri.tenant_id=action.tenant_id AND dri.external_key='goal5-dri'
  JOIN ontology_registry.versions version ON version.tenant_id=action.tenant_id AND version.status='active'
 WHERE action.tenant_id=:'tenant_id'::uuid AND action.idempotency_key LIKE 'goal5-action-%'
ON CONFLICT (tenant_id, action_intent_id, expected_outcome_id) DO NOTHING;

UPDATE decision.expected_outcomes SET status='achieved', updated_at=now()
 WHERE tenant_id=:'tenant_id'::uuid AND owner_reference='goal5-p2';

RESET ROLE;
SET ROLE ontology_app;
SELECT set_config('app.tenant_id', :'tenant_id', false);

INSERT INTO decision.learnings (
  tenant_id, verification_id, decision_id, finding_summary, cause_category,
  recommended_change, change_scope, status, ontology_version_id
)
SELECT :'tenant_id'::uuid, verification.id, verification.decision_id,
       'Keep execution, operational, and goal verification separate: ' || verification.id::text,
       'measurement', '{"type":"proposal_only"}'::jsonb, 'process', 'proposed', version.id
  FROM decision.verifications verification
  JOIN ontology_registry.versions version ON version.tenant_id=verification.tenant_id AND version.status='active'
 WHERE verification.tenant_id=:'tenant_id'::uuid AND verification.verification_status='completed';

DO $$
DECLARE
  lineage decision.lineage_v1%ROWTYPE;
BEGIN
  SELECT * INTO lineage FROM decision.lineage_v1
   WHERE tenant_id=platform.current_tenant_id() AND decision_case_external_key='goal5-decision';
  IF lineage.task_count <> 2 OR lineage.accepted_task_count <> 2 OR
     lineage.action_count <> 2 OR lineage.verification_count <> 2 OR lineage.learning_count <> 2 OR
     lineage.execution_success IS DISTINCT FROM true OR
     lineage.operational_success IS DISTINCT FROM true OR lineage.goal_success IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'lineage aggregation mismatch: %', row_to_json(lineage);
  END IF;
END
$$;

SELECT decision_case_external_key, task_count, action_count, verification_count,
       learning_count, execution_success, operational_success, goal_success, practice_status
  FROM decision.practice_status_v1
 WHERE tenant_id=:'tenant_id'::uuid AND decision_case_external_key='goal5-decision';

RESET ROLE;
