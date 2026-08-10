BEGIN;

CREATE SCHEMA IF NOT EXISTS strategic_intelligence;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intelligence_collector') THEN
    CREATE ROLE intelligence_collector NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intelligence_orchestrator') THEN
    CREATE ROLE intelligence_orchestrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intelligence_retrieval') THEN
    CREATE ROLE intelligence_retrieval NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION strategic_intelligence.current_principal_key()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.principal_key', true), '')
$$;

CREATE OR REPLACE FUNCTION strategic_intelligence.current_purpose()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.purpose', true), '')
$$;

CREATE TABLE IF NOT EXISTS strategic_intelligence.source_registry_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  source_key text NOT NULL,
  registry_version text NOT NULL,
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('pending','enabled','paused','revoked')),
  license_status text NOT NULL CHECK (license_status IN ('pending','approved','expired','rejected')),
  compliance_approval_status text NOT NULL CHECK (compliance_approval_status IN ('pending','approved','rejected')),
  storage_level text NOT NULL CHECK (storage_level IN ('reference_only','metadata_only','summary_metadata','structured_data','full_text')),
  retention_days integer NOT NULL CHECK (retention_days > 0),
  definition jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (tenant_id, source_key, registry_version),
  UNIQUE (tenant_id, content_hash)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.source_registry_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  source_entry_id uuid REFERENCES strategic_intelligence.source_registry_entries(id),
  source_key text NOT NULL,
  registry_version text NOT NULL,
  registry_hash text NOT NULL CHECK (registry_hash ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','deny')),
  reason_code text NOT NULL,
  request_key text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_key)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  run_key text NOT NULL,
  collector_version text NOT NULL,
  source_registry_version text NOT NULL,
  source_registry_hash text NOT NULL CHECK (source_registry_hash ~ '^[0-9a-f]{64}$'),
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  replay_of_run_id uuid REFERENCES strategic_intelligence.ingestion_runs(id),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  UNIQUE (tenant_id, run_key)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.raw_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  ingestion_run_id uuid NOT NULL REFERENCES strategic_intelligence.ingestion_runs(id),
  source_decision_id uuid NOT NULL REFERENCES strategic_intelligence.source_registry_decisions(id),
  source_entry_id uuid NOT NULL REFERENCES strategic_intelligence.source_registry_entries(id),
  snapshot_key text NOT NULL CHECK (snapshot_key ~ '^[0-9a-f]{64}$'),
  source_key text NOT NULL,
  source_reference text NOT NULL,
  fetched_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  dedup_key text NOT NULL CHECK (dedup_key ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  payload_bytes bytea,
  storage_tier text NOT NULL DEFAULT 'hot' CHECK (storage_tier IN ('hot','cold','purged')),
  archive_reference text,
  archive_hash text CHECK (archive_hash IS NULL OR archive_hash ~ '^[0-9a-f]{64}$'),
  retention_expires_at timestamptz NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  sanitization_status text NOT NULL CHECK (sanitization_status IN ('untrusted','sanitized','rejected')),
  collector_version text NOT NULL,
  source_registry_version text NOT NULL,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (recorded_at >= fetched_at),
  CHECK (
    (storage_tier = 'hot' AND payload_bytes IS NOT NULL)
    OR (storage_tier = 'cold' AND archive_reference IS NOT NULL AND archive_hash IS NOT NULL)
    OR (storage_tier = 'purged' AND payload_bytes IS NULL AND archive_reference IS NULL)
  ),
  UNIQUE (tenant_id, snapshot_key),
  UNIQUE (tenant_id, source_key, content_hash),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.external_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  snapshot_id uuid NOT NULL REFERENCES strategic_intelligence.raw_snapshots(id),
  observation_key text NOT NULL,
  source_external_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  parser_version text NOT NULL,
  schema_version text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  data_quality_status text NOT NULL CHECK (data_quality_status IN ('valid','partial','invalid','unknown')),
  freshness_status text NOT NULL CHECK (freshness_status IN ('fresh','aging','stale','unknown')),
  conflict_status text NOT NULL CHECK (conflict_status IN ('none','suspected','confirmed','resolved')),
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  purpose text NOT NULL,
  status text NOT NULL CHECK (status IN ('observed','superseded','rejected','expired')),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (valid_from <= observed_at),
  UNIQUE (tenant_id, observation_key),
  UNIQUE (tenant_id, snapshot_id, source_external_key, parser_version)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.strategic_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  signal_key text NOT NULL,
  signal_type text NOT NULL,
  title text NOT NULL CHECK (char_length(title) <= 500),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  strength numeric(5,4) NOT NULL CHECK (strength BETWEEN 0 AND 1),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  signal_status text NOT NULL CHECK (signal_status IN ('candidate','active','weakening','expired','rejected')),
  data_quality_status text NOT NULL CHECK (data_quality_status IN ('valid','partial','invalid','unknown')),
  freshness_status text NOT NULL CHECK (freshness_status IN ('fresh','aging','stale','unknown')),
  conflict_status text NOT NULL CHECK (conflict_status IN ('none','suspected','confirmed','resolved')),
  ontology_version text NOT NULL,
  causal_graph_version text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  purpose text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (tenant_id, signal_key, recorded_at)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.signal_observations (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  signal_id uuid NOT NULL REFERENCES strategic_intelligence.strategic_signals(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES strategic_intelligence.external_observations(id),
  contribution_weight numeric(5,4) CHECK (contribution_weight IS NULL OR contribution_weight BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, signal_id, observation_id)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  evidence_key text NOT NULL,
  observation_id uuid NOT NULL REFERENCES strategic_intelligence.external_observations(id),
  signal_id uuid REFERENCES strategic_intelligence.strategic_signals(id),
  snapshot_id uuid NOT NULL REFERENCES strategic_intelligence.raw_snapshots(id),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('support','challenge','context')),
  summary text NOT NULL CHECK (char_length(summary) <= 4000),
  confidence numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('candidate','accepted','superseded','rejected','expired')),
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  purpose text NOT NULL,
  provenance jsonb NOT NULL,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (tenant_id, evidence_key, recorded_at)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.impact_hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  hypothesis_key text NOT NULL,
  external_factor_key text NOT NULL,
  goal_facet_key text NOT NULL,
  transmission_path jsonb NOT NULL CHECK (jsonb_typeof(transmission_path) = 'array'),
  impact_direction text NOT NULL CHECK (impact_direction IN ('positive','negative','mixed','unknown')),
  impact_strength numeric(5,4) CHECK (impact_strength IS NULL OR impact_strength BETWEEN 0 AND 1),
  expected_lag_days integer CHECK (expected_lag_days IS NULL OR expected_lag_days >= 0),
  generation_status text NOT NULL DEFAULT 'generated_draft' CHECK (generation_status = 'generated_draft'),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','rejected')),
  activation_status text NOT NULL DEFAULT 'inactive' CHECK (activation_status IN ('inactive','active','paused','expired')),
  reviewer_dri text,
  causal_graph_version text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (activation_status <> 'active' OR (verification_status = 'verified' AND reviewer_dri IS NOT NULL)),
  UNIQUE (tenant_id, hypothesis_key, causal_graph_version)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.impact_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  assessment_key text NOT NULL,
  hypothesis_id uuid NOT NULL REFERENCES strategic_intelligence.impact_hypotheses(id),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  evidence_cutoff_at timestamptz NOT NULL,
  impact_direction text NOT NULL CHECK (impact_direction IN ('positive','negative','mixed','unknown')),
  impact_magnitude numeric(8,4),
  confidence_band text NOT NULL CHECK (confidence_band IN ('insufficient','low','medium','high')),
  assessment_status text NOT NULL CHECK (assessment_status IN ('draft','review_required','accepted','rejected','expired')),
  ontology_version text NOT NULL,
  causal_graph_version text NOT NULL,
  model_provider text,
  model_id text,
  prompt_version text,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  purpose text NOT NULL,
  CHECK (window_start < window_end),
  CHECK (evidence_cutoff_at >= window_end),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (tenant_id, assessment_key, recorded_at)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.assessment_evidence (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  assessment_id uuid NOT NULL REFERENCES strategic_intelligence.impact_assessments(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES strategic_intelligence.evidence(id),
  relationship text NOT NULL CHECK (relationship IN ('support','challenge','context')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, assessment_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  report_run_key text NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('daily','weekly','monthly','quarterly','semiannual','annual','alert','company','p003')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  evidence_cutoff_at timestamptz NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  source_registry_version text NOT NULL,
  ontology_version text NOT NULL,
  causal_graph_version text NOT NULL,
  model_provider text NOT NULL,
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_microunits bigint NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  error_code text,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start < period_end),
  CHECK (evidence_cutoff_at >= period_end),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  UNIQUE (tenant_id, report_run_key)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.report_run_inputs (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  report_run_id uuid NOT NULL REFERENCES strategic_intelligence.report_runs(id) ON DELETE CASCADE,
  input_type text NOT NULL CHECK (input_type IN ('raw_snapshot','observation','signal','evidence','impact_assessment','operating_metric')),
  input_id uuid NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, report_run_id, input_type, input_id)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  report_run_id uuid NOT NULL REFERENCES strategic_intelligence.report_runs(id),
  report_key text NOT NULL,
  audience_scope text NOT NULL,
  report_status text NOT NULL CHECK (report_status IN ('draft','review_required','approved','published','superseded','rejected')),
  structured_body jsonb NOT NULL,
  projection_version text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, report_key, projection_version)
);

CREATE TABLE IF NOT EXISTS strategic_intelligence.acl_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  object_type text NOT NULL CHECK (object_type IN ('strategic_signal','evidence','impact_assessment','report')),
  object_id uuid NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user','department','chat','role')),
  principal_key text NOT NULL,
  purpose text NOT NULL,
  permission text NOT NULL CHECK (permission IN ('read','review','approve')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (tenant_id, object_type, object_id, principal_type, principal_key, purpose, permission)
);

CREATE INDEX IF NOT EXISTS strategic_intelligence_source_status_idx ON strategic_intelligence.source_registry_entries (tenant_id, source_key, lifecycle_status, valid_from DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_decision_time_idx ON strategic_intelligence.source_registry_decisions (tenant_id, source_key, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_snapshot_time_idx ON strategic_intelligence.raw_snapshots (tenant_id, source_key, fetched_at DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_snapshot_retention_idx ON strategic_intelligence.raw_snapshots (tenant_id, storage_tier, retention_expires_at);
CREATE INDEX IF NOT EXISTS strategic_intelligence_observation_time_idx ON strategic_intelligence.external_observations (tenant_id, observed_at DESC, freshness_status);
CREATE INDEX IF NOT EXISTS strategic_intelligence_signal_time_idx ON strategic_intelligence.strategic_signals (tenant_id, signal_status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_evidence_time_idx ON strategic_intelligence.evidence (tenant_id, status, valid_from DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_assessment_time_idx ON strategic_intelligence.impact_assessments (tenant_id, assessment_status, window_end DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_report_run_period_idx ON strategic_intelligence.report_runs (tenant_id, report_type, period_end DESC);
CREATE INDEX IF NOT EXISTS strategic_intelligence_acl_lookup_idx ON strategic_intelligence.acl_entries (tenant_id, object_type, object_id, principal_key, purpose, permission);

CREATE OR REPLACE FUNCTION strategic_intelligence.guard_raw_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.retention_job', true) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'raw snapshots are append-only outside an approved retention job' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS strategic_intelligence_raw_snapshot_immutable ON strategic_intelligence.raw_snapshots;
CREATE TRIGGER strategic_intelligence_raw_snapshot_immutable
BEFORE UPDATE OR DELETE ON strategic_intelligence.raw_snapshots
FOR EACH ROW EXECUTE FUNCTION strategic_intelligence.guard_raw_snapshot_immutable();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'strategic_intelligence.source_registry_entries',
    'strategic_intelligence.source_registry_decisions',
    'strategic_intelligence.ingestion_runs',
    'strategic_intelligence.raw_snapshots',
    'strategic_intelligence.external_observations',
    'strategic_intelligence.strategic_signals',
    'strategic_intelligence.signal_observations',
    'strategic_intelligence.evidence',
    'strategic_intelligence.impact_hypotheses',
    'strategic_intelligence.impact_assessments',
    'strategic_intelligence.assessment_evidence',
    'strategic_intelligence.report_runs',
    'strategic_intelligence.report_run_inputs',
    'strategic_intelligence.reports',
    'strategic_intelligence.acl_entries'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS collector_tenant ON %s', table_name);
    EXECUTE format('CREATE POLICY collector_tenant ON %s TO intelligence_collector USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', table_name);
    EXECUTE format('DROP POLICY IF EXISTS orchestrator_tenant ON %s', table_name);
    EXECUTE format('CREATE POLICY orchestrator_tenant ON %s TO intelligence_orchestrator USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', table_name);
  END LOOP;
END
$$;

DROP POLICY IF EXISTS retrieval_acl_metadata ON strategic_intelligence.acl_entries;
CREATE POLICY retrieval_acl_metadata ON strategic_intelligence.acl_entries
TO intelligence_retrieval
USING (tenant_id = platform.current_tenant_id());

DROP POLICY IF EXISTS retrieval_signal_acl ON strategic_intelligence.strategic_signals;
CREATE POLICY retrieval_signal_acl ON strategic_intelligence.strategic_signals
FOR SELECT TO intelligence_retrieval
USING (
  tenant_id = platform.current_tenant_id()
  AND strategic_intelligence.current_principal_key() IS NOT NULL
  AND strategic_intelligence.current_purpose() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM strategic_intelligence.acl_entries acl
    WHERE acl.tenant_id = strategic_intelligence.strategic_signals.tenant_id
      AND acl.object_type = 'strategic_signal'
      AND acl.object_id = strategic_intelligence.strategic_signals.id
      AND acl.principal_key = strategic_intelligence.current_principal_key()
      AND acl.purpose = strategic_intelligence.current_purpose()
      AND acl.permission = 'read'
      AND acl.valid_from <= now()
      AND (acl.valid_to IS NULL OR acl.valid_to > now())
  )
);

DROP POLICY IF EXISTS retrieval_evidence_acl ON strategic_intelligence.evidence;
CREATE POLICY retrieval_evidence_acl ON strategic_intelligence.evidence
FOR SELECT TO intelligence_retrieval
USING (
  tenant_id = platform.current_tenant_id()
  AND strategic_intelligence.current_principal_key() IS NOT NULL
  AND strategic_intelligence.current_purpose() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM strategic_intelligence.acl_entries acl
    WHERE acl.tenant_id = strategic_intelligence.evidence.tenant_id
      AND acl.object_type = 'evidence'
      AND acl.object_id = strategic_intelligence.evidence.id
      AND acl.principal_key = strategic_intelligence.current_principal_key()
      AND acl.purpose = strategic_intelligence.current_purpose()
      AND acl.permission = 'read'
      AND acl.valid_from <= now()
      AND (acl.valid_to IS NULL OR acl.valid_to > now())
  )
);

DROP POLICY IF EXISTS retrieval_assessment_acl ON strategic_intelligence.impact_assessments;
CREATE POLICY retrieval_assessment_acl ON strategic_intelligence.impact_assessments
FOR SELECT TO intelligence_retrieval
USING (
  tenant_id = platform.current_tenant_id()
  AND strategic_intelligence.current_principal_key() IS NOT NULL
  AND strategic_intelligence.current_purpose() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM strategic_intelligence.acl_entries acl
    WHERE acl.tenant_id = strategic_intelligence.impact_assessments.tenant_id
      AND acl.object_type = 'impact_assessment'
      AND acl.object_id = strategic_intelligence.impact_assessments.id
      AND acl.principal_key = strategic_intelligence.current_principal_key()
      AND acl.purpose = strategic_intelligence.current_purpose()
      AND acl.permission = 'read'
      AND acl.valid_from <= now()
      AND (acl.valid_to IS NULL OR acl.valid_to > now())
  )
);

DROP POLICY IF EXISTS retrieval_report_acl ON strategic_intelligence.reports;
CREATE POLICY retrieval_report_acl ON strategic_intelligence.reports
FOR SELECT TO intelligence_retrieval
USING (
  tenant_id = platform.current_tenant_id()
  AND strategic_intelligence.current_principal_key() IS NOT NULL
  AND strategic_intelligence.current_purpose() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM strategic_intelligence.acl_entries acl
    WHERE acl.tenant_id = strategic_intelligence.reports.tenant_id
      AND acl.object_type = 'report'
      AND acl.object_id = strategic_intelligence.reports.id
      AND acl.principal_key = strategic_intelligence.current_principal_key()
      AND acl.purpose = strategic_intelligence.current_purpose()
      AND acl.permission = 'read'
      AND acl.valid_from <= now()
      AND (acl.valid_to IS NULL OR acl.valid_to > now())
  )
);

REVOKE ALL ON SCHEMA strategic_intelligence FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA strategic_intelligence FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA strategic_intelligence FROM PUBLIC;

GRANT USAGE ON SCHEMA strategic_intelligence, platform TO intelligence_collector, intelligence_orchestrator, intelligence_retrieval;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO intelligence_collector, intelligence_orchestrator, intelligence_retrieval;
GRANT EXECUTE ON FUNCTION strategic_intelligence.current_principal_key(), strategic_intelligence.current_purpose() TO intelligence_retrieval;

GRANT SELECT ON strategic_intelligence.source_registry_entries TO intelligence_collector;
GRANT SELECT, INSERT ON strategic_intelligence.source_registry_decisions TO intelligence_collector;
GRANT SELECT, INSERT, UPDATE ON strategic_intelligence.ingestion_runs TO intelligence_collector;
GRANT SELECT, INSERT ON strategic_intelligence.raw_snapshots, strategic_intelligence.external_observations TO intelligence_collector;

GRANT SELECT ON ALL TABLES IN SCHEMA strategic_intelligence TO intelligence_orchestrator;
GRANT INSERT, UPDATE ON strategic_intelligence.strategic_signals, strategic_intelligence.signal_observations, strategic_intelligence.evidence, strategic_intelligence.impact_hypotheses, strategic_intelligence.impact_assessments, strategic_intelligence.assessment_evidence, strategic_intelligence.report_runs, strategic_intelligence.report_run_inputs, strategic_intelligence.reports, strategic_intelligence.acl_entries TO intelligence_orchestrator;

GRANT SELECT ON strategic_intelligence.acl_entries, strategic_intelligence.strategic_signals, strategic_intelligence.evidence, strategic_intelligence.impact_assessments, strategic_intelligence.reports TO intelligence_retrieval;

COMMIT;
