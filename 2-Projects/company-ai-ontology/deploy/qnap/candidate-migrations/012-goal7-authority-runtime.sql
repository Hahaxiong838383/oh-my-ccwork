BEGIN;

CREATE TABLE IF NOT EXISTS iam.principal_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  principal_id uuid NOT NULL REFERENCES iam.principals(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('department', 'chat')),
  subject_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'unknown')),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  observed_at timestamptz NOT NULL,
  source_version text NOT NULL,
  source_event_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, principal_id, subject_type, subject_key, valid_from)
);

CREATE INDEX IF NOT EXISTS principal_memberships_lookup_idx
  ON iam.principal_memberships (tenant_id, principal_id, subject_type, subject_key, status, observed_at DESC);

CREATE TABLE IF NOT EXISTS work.conversation_authority_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  case_id uuid,
  request_principal_id uuid REFERENCES iam.principals(id),
  request_principal_external_key text NOT NULL,
  conversation_type text NOT NULL CHECK (conversation_type IN ('private', 'chat', 'unknown')),
  conversation_reference_hash text,
  purpose text NOT NULL CHECK (purpose IN ('company_knowledge_query', 'task_execution_support', 'decision_support', 'result_submission')),
  membership_observed_at timestamptz,
  resource_acl_snapshot_hash text,
  decision text NOT NULL CHECK (decision IN ('allow', 'deny', 'unknown')),
  reason_code text NOT NULL,
  rule_version text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES work.brain_cases(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS conversation_authority_case_idx
  ON work.conversation_authority_snapshots (tenant_id, case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime.h_engine_route_state (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  route_key text NOT NULL CHECK (route_key IN ('route-a', 'route-b')),
  enabled boolean NOT NULL,
  circuit_state text NOT NULL CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  credential_mode text NOT NULL,
  provider text,
  model text,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  opened_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, route_key)
);

CREATE TABLE IF NOT EXISTS runtime.h_engine_usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  request_id text NOT NULL,
  case_id uuid,
  route_key text NOT NULL CHECK (route_key IN ('route-a', 'route-b')),
  work_type text,
  department_key text,
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  estimated_cost_micros bigint NOT NULL DEFAULT 0 CHECK (estimated_cost_micros >= 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  outcome text NOT NULL,
  provider text,
  model text,
  credential_mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id, route_key),
  FOREIGN KEY (tenant_id, case_id) REFERENCES work.brain_cases(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS h_engine_usage_budget_idx
  ON runtime.h_engine_usage_events (tenant_id, route_key, created_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'iam.principal_memberships',
    'work.conversation_authority_snapshots',
    'runtime.h_engine_route_state',
    'runtime.h_engine_usage_events'
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

GRANT SELECT, INSERT, UPDATE ON iam.principal_memberships, runtime.h_engine_route_state TO ontology_app;
GRANT SELECT, INSERT ON work.conversation_authority_snapshots, runtime.h_engine_usage_events TO ontology_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA runtime TO ontology_app;
GRANT SELECT ON iam.principal_memberships, work.conversation_authority_snapshots, runtime.h_engine_route_state, runtime.h_engine_usage_events TO ontology_readonly;

REVOKE DELETE ON iam.principal_memberships, work.conversation_authority_snapshots, runtime.h_engine_route_state, runtime.h_engine_usage_events FROM ontology_app, ontology_readonly;

COMMIT;
