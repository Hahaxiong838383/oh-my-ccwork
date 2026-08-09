BEGIN;

CREATE TABLE IF NOT EXISTS work.brain_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  external_case_id text NOT NULL,
  principal_id uuid REFERENCES iam.principals(id),
  principal_external_key text NOT NULL,
  purpose text NOT NULL,
  work_mode text NOT NULL CHECK (work_mode IN (
    'answer_query', 'situation_analysis', 'decision_support',
    'p2_orchestration', 'governed_action', 'learning_review'
  )),
  request_summary text NOT NULL CHECK (char_length(request_summary) <= 500),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_outcome text CHECK (requested_outcome IS NULL OR char_length(requested_outcome) <= 500),
  status text NOT NULL CHECK (status IN (
    'received', 'scoped', 'authority_checked', 'evidence_collecting', 'evidence_ready',
    'synthesizing', 'response_ready', 'completed', 'clarification_required',
    'permission_denied', 'blocked', 'insufficient_evidence', 'review_required'
  )),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  security_domain text NOT NULL DEFAULT 'company',
  classification text NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  policy_snapshot_id text,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  protocol_version text NOT NULL DEFAULT '1.0.0',
  processing_mode text NOT NULL DEFAULT 'shadow' CHECK (processing_mode IN ('shadow', 'active')),
  conversation_reference_hash text CHECK (
    conversation_reference_hash IS NULL OR conversation_reference_hash ~ '^[0-9a-f]{64}$'
  ),
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  confidence_level text CHECK (confidence_level IS NULL OR confidence_level IN ('high', 'medium', 'low', 'insufficient')),
  deterministic_conclusion_allowed boolean,
  response_validation_status text CHECK (
    response_validation_status IS NULL OR response_validation_status IN ('valid', 'fallback', 'shadow', 'failed')
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_case_id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS brain_cases_status_time_idx
  ON work.brain_cases (tenant_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS brain_cases_principal_time_idx
  ON work.brain_cases (tenant_id, principal_id, started_at DESC);

CREATE TABLE IF NOT EXISTS work.brain_case_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  case_id uuid NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no >= 0),
  stage_type text NOT NULL CHECK (stage_type IN (
    'intake', 'scope', 'authority', 'context', 'evidence', 'synthesis', 'response',
    'decision', 'plan', 'execution', 'verification', 'learning'
  )),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'completed', 'blocked', 'skipped', 'contract_only')),
  input_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(input_references) = 'array'),
  output_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(output_references) = 'array'),
  policy_decision_reference text,
  block_reason_code text,
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, case_id, sequence_no),
  UNIQUE (tenant_id, case_id, stage_type),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES work.brain_cases(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS brain_case_stages_case_idx
  ON work.brain_case_stages (tenant_id, case_id, sequence_no);

CREATE TABLE IF NOT EXISTS work.brain_case_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  case_id uuid NOT NULL,
  stage_id uuid,
  event_type text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, case_id) REFERENCES work.brain_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES work.brain_case_stages(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS brain_case_events_replay_idx
  ON work.brain_case_events (tenant_id, case_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS epistemic.assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  case_id uuid NOT NULL,
  statement_summary text NOT NULL CHECK (char_length(statement_summary) <= 1000),
  impact text NOT NULL CHECK (char_length(impact) <= 500),
  verification_status text NOT NULL CHECK (verification_status IN ('unverified', 'verified', 'rejected', 'expired')),
  provenance_id uuid REFERENCES epistemic.provenance_records(id),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES work.brain_cases(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS assumptions_case_idx
  ON epistemic.assumptions (tenant_id, case_id, verification_status);

CREATE TABLE IF NOT EXISTS epistemic.unknowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  case_id uuid NOT NULL,
  description text NOT NULL CHECK (char_length(description) <= 1000),
  impact text NOT NULL CHECK (char_length(impact) <= 500),
  resolution_status text NOT NULL CHECK (resolution_status IN ('open', 'resolved', 'accepted', 'expired')),
  provenance_id uuid REFERENCES epistemic.provenance_records(id),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES work.brain_cases(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS unknowns_case_idx
  ON epistemic.unknowns (tenant_id, case_id, resolution_status);

CREATE TABLE IF NOT EXISTS epistemic.assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  case_id uuid NOT NULL,
  evidence_package_id text NOT NULL,
  completeness text NOT NULL CHECK (completeness IN ('sufficient', 'partial', 'insufficient')),
  freshness_status text NOT NULL CHECK (freshness_status IN ('fresh', 'mixed', 'stale', 'unknown')),
  contradiction_status text NOT NULL CHECK (contradiction_status IN ('none', 'possible', 'conflicting')),
  confidence_level text NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low', 'insufficient')),
  deterministic_conclusion_allowed boolean NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_references) = 'array'),
  excluded_reason_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  truncation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance_id uuid REFERENCES epistemic.provenance_records(id),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  valid_until timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, case_id, evidence_package_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES work.brain_cases(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS assessments_case_idx
  ON epistemic.assessments (tenant_id, case_id, created_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'work.brain_cases',
    'work.brain_case_stages',
    'work.brain_case_events',
    'epistemic.assumptions',
    'epistemic.unknowns',
    'epistemic.assessments'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = split_part(table_name, '.', 1)
        AND tablename = split_part(table_name, '.', 2)
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE VIEW work.brain_case_status_v1
WITH (security_invoker = true)
AS
SELECT
  c.id AS case_id,
  c.tenant_id,
  c.work_mode,
  c.status,
  c.processing_mode,
  c.evidence_count,
  c.confidence_level,
  c.deterministic_conclusion_allowed,
  c.response_validation_status,
  c.started_at,
  c.completed_at,
  COALESCE(count(s.id), 0)::integer AS stage_count,
  COALESCE(count(s.id) FILTER (WHERE s.status = 'completed'), 0)::integer AS completed_stage_count,
  COALESCE(count(s.id) FILTER (WHERE s.status = 'contract_only'), 0)::integer AS contract_only_stage_count
FROM work.brain_cases c
LEFT JOIN work.brain_case_stages s
  ON s.tenant_id = c.tenant_id AND s.case_id = c.id
GROUP BY c.id;

CREATE OR REPLACE VIEW epistemic.answer_basis_v1
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (a.tenant_id, a.case_id)
  a.tenant_id,
  a.case_id,
  a.evidence_package_id,
  a.completeness,
  a.freshness_status,
  a.contradiction_status,
  a.confidence_level,
  a.deterministic_conclusion_allowed,
  jsonb_array_length(a.evidence_references) AS evidence_reference_count,
  a.excluded_reason_counts,
  a.valid_until,
  a.created_at
FROM epistemic.assessments a
ORDER BY a.tenant_id, a.case_id, a.created_at DESC;

GRANT USAGE ON SCHEMA work, epistemic TO ontology_app, ontology_readonly;

GRANT SELECT, INSERT, UPDATE ON
  work.brain_cases,
  work.brain_case_stages,
  epistemic.assumptions,
  epistemic.unknowns
TO ontology_app;

GRANT SELECT, INSERT ON
  work.brain_case_events,
  epistemic.assessments
TO ontology_app;

GRANT SELECT ON
  work.brain_case_status_v1,
  epistemic.answer_basis_v1
TO ontology_app;

GRANT SELECT ON
  work.brain_cases,
  work.brain_case_stages,
  work.brain_case_events,
  work.brain_case_status_v1,
  epistemic.assumptions,
  epistemic.unknowns,
  epistemic.assessments,
  epistemic.answer_basis_v1
TO ontology_readonly;

REVOKE DELETE ON
  work.brain_cases,
  work.brain_case_stages,
  work.brain_case_events,
  epistemic.assumptions,
  epistemic.unknowns,
  epistemic.assessments
FROM ontology_app, ontology_readonly, ontology_registry, action_gateway;

REVOKE UPDATE, DELETE ON work.brain_case_events, epistemic.assessments
FROM ontology_app, ontology_readonly, ontology_registry, action_gateway;

COMMIT;
