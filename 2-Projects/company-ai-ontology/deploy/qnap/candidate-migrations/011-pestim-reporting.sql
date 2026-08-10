BEGIN;

CREATE TABLE IF NOT EXISTS strategic_intelligence.report_input_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  input_set_key text NOT NULL CHECK (input_set_key ~ '^[0-9a-f]{64}$'),
  report_type text NOT NULL CHECK (report_type IN ('daily','weekly','monthly','quarterly','semiannual','annual','alert','company','p003')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  evidence_cutoff_at timestamptz NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  source_snapshot_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  source_registry_version text NOT NULL,
  ontology_version text NOT NULL,
  causal_graph_version text NOT NULL,
  input_manifest jsonb NOT NULL CHECK (jsonb_typeof(input_manifest) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start < period_end),
  CHECK (evidence_cutoff_at >= period_end),
  UNIQUE (tenant_id, input_set_key),
  UNIQUE (tenant_id, input_hash)
);

ALTER TABLE strategic_intelligence.report_runs
  ADD COLUMN IF NOT EXISTS input_set_id uuid REFERENCES strategic_intelligence.report_input_sets(id);

ALTER TABLE strategic_intelligence.acl_entries
  DROP CONSTRAINT IF EXISTS acl_entries_object_type_check;
ALTER TABLE strategic_intelligence.acl_entries
  ADD CONSTRAINT acl_entries_object_type_check CHECK (object_type IN ('strategic_signal','evidence','impact_assessment','report','alert'));

CREATE TABLE IF NOT EXISTS strategic_intelligence.report_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  report_id uuid NOT NULL REFERENCES strategic_intelligence.reports(id) ON DELETE CASCADE,
  projection_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('feishu_document','feishu_card','h_control_plane')),
  template_version text NOT NULL,
  target_scope text NOT NULL,
  projection_status text NOT NULL CHECK (projection_status IN ('draft','review_required','approved','published','failed','superseded')),
  rendered_payload jsonb NOT NULL,
  rendered_hash text NOT NULL CHECK (rendered_hash ~ '^[0-9a-f]{64}$'),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, projection_key, template_version),
  UNIQUE (tenant_id, report_id, channel, template_version, target_scope)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  alert_key text NOT NULL,
  alert_type text NOT NULL CHECK (alert_type IN ('regulatory','customer','supplier','competitor','technology','security','market')),
  severity text NOT NULL CHECK (severity IN ('info','warning','high','critical')),
  detected_at timestamptz NOT NULL,
  evidence_cutoff_at timestamptz NOT NULL,
  confidence_band text NOT NULL CHECK (confidence_band IN ('insufficient','low','medium','high')),
  alert_status text NOT NULL CHECK (alert_status IN ('candidate','review_required','acknowledged','work_case_opened','closed','rejected')),
  work_case_id uuid,
  ontology_version text NOT NULL,
  causal_graph_version text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (evidence_cutoff_at <= detected_at),
  CHECK (alert_status <> 'work_case_opened' OR work_case_id IS NOT NULL),
  FOREIGN KEY (tenant_id, work_case_id) REFERENCES work.brain_cases(tenant_id, id),
  UNIQUE (tenant_id, alert_key)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.alert_evidence (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  alert_id uuid NOT NULL REFERENCES strategic_intelligence.alerts(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES strategic_intelligence.evidence(id),
  relationship text NOT NULL CHECK (relationship IN ('support','challenge','context')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alert_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS strategic_intelligence_input_set_period_idx ON strategic_intelligence.report_input_sets (tenant_id, report_type, period_end DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_projection_status_idx ON strategic_intelligence.report_projections (tenant_id, channel, projection_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_alert_time_idx ON strategic_intelligence.alerts (tenant_id, alert_status, severity, detected_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'strategic_intelligence.report_input_sets',
    'strategic_intelligence.report_projections',
    'strategic_intelligence.alerts',
    'strategic_intelligence.alert_evidence'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS orchestrator_tenant ON %s', table_name);
    EXECUTE format('CREATE POLICY orchestrator_tenant ON %s TO intelligence_orchestrator USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', table_name);
  END LOOP;
END
$$;

DROP POLICY IF EXISTS retrieval_projection_acl ON strategic_intelligence.report_projections;
CREATE POLICY retrieval_projection_acl ON strategic_intelligence.report_projections
FOR SELECT TO intelligence_retrieval
USING (
  tenant_id = platform.current_tenant_id()
  AND strategic_intelligence.current_principal_key() IS NOT NULL
  AND strategic_intelligence.current_purpose() IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM strategic_intelligence.reports report
    JOIN strategic_intelligence.acl_entries acl
      ON acl.tenant_id = report.tenant_id
     AND acl.object_type = 'report'
     AND acl.object_id = report.id
    WHERE report.tenant_id = strategic_intelligence.report_projections.tenant_id
      AND report.id = strategic_intelligence.report_projections.report_id
      AND acl.principal_key = strategic_intelligence.current_principal_key()
      AND acl.purpose = strategic_intelligence.current_purpose()
      AND acl.permission = 'read'
      AND acl.valid_from <= now()
      AND (acl.valid_to IS NULL OR acl.valid_to > now())
  )
);

DROP POLICY IF EXISTS retrieval_alert_acl ON strategic_intelligence.alerts;
CREATE POLICY retrieval_alert_acl ON strategic_intelligence.alerts
FOR SELECT TO intelligence_retrieval
USING (
  tenant_id = platform.current_tenant_id()
  AND strategic_intelligence.current_principal_key() IS NOT NULL
  AND strategic_intelligence.current_purpose() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM strategic_intelligence.acl_entries acl
    WHERE acl.tenant_id = strategic_intelligence.alerts.tenant_id
      AND acl.object_type = 'alert'
      AND acl.object_id = strategic_intelligence.alerts.id
      AND acl.principal_key = strategic_intelligence.current_principal_key()
      AND acl.purpose = strategic_intelligence.current_purpose()
      AND acl.permission = 'read'
      AND acl.valid_from <= now()
      AND (acl.valid_to IS NULL OR acl.valid_to > now())
  )
);

REVOKE ALL ON strategic_intelligence.report_input_sets, strategic_intelligence.report_projections, strategic_intelligence.alerts, strategic_intelligence.alert_evidence FROM PUBLIC;

GRANT SELECT, INSERT ON strategic_intelligence.report_input_sets TO intelligence_orchestrator;
GRANT SELECT, INSERT, UPDATE ON strategic_intelligence.report_projections, strategic_intelligence.alerts TO intelligence_orchestrator;
GRANT SELECT, INSERT ON strategic_intelligence.alert_evidence TO intelligence_orchestrator;
GRANT SELECT ON strategic_intelligence.report_projections, strategic_intelligence.alerts TO intelligence_retrieval;

COMMIT;
