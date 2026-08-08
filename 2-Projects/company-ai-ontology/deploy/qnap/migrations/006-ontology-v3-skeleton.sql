BEGIN;

CREATE SCHEMA IF NOT EXISTS ontology_registry;
CREATE SCHEMA IF NOT EXISTS ontology_runtime;
CREATE SCHEMA IF NOT EXISTS epistemic;
CREATE SCHEMA IF NOT EXISTS decision;
CREATE SCHEMA IF NOT EXISTS security;
CREATE SCHEMA IF NOT EXISTS work;
CREATE SCHEMA IF NOT EXISTS action;

SELECT format(
  'CREATE ROLE ontology_registry LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'ontology_registry_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontology_registry')
\gexec

ALTER ROLE ontology_registry PASSWORD :'ontology_registry_password';

CREATE TABLE IF NOT EXISTS ontology_registry.versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  schema_version text NOT NULL,
  version_tag text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-fA-F]{7,64}$'),
  compatibility text NOT NULL CHECK (compatibility IN ('bootstrap', 'compatible', 'migration_required')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'rejected')),
  proposal_id text NOT NULL,
  approved_by_external_key text NOT NULL,
  migration_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  definition jsonb NOT NULL,
  deployed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, content_hash),
  UNIQUE (tenant_id, version_tag)
);

CREATE UNIQUE INDEX IF NOT EXISTS ontology_registry_one_active_idx
  ON ontology_registry.versions (tenant_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ontology_registry.elements (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  version_id uuid NOT NULL REFERENCES ontology_registry.versions(id) ON DELETE CASCADE,
  element_kind text NOT NULL CHECK (element_kind IN (
    'object_type', 'link_type', 'function_type', 'action_type', 'policy_type', 'constraint_type'
  )),
  qualified_name text NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, element_kind, qualified_name)
);

CREATE INDEX IF NOT EXISTS ontology_registry_elements_lookup_idx
  ON ontology_registry.elements (tenant_id, element_kind, qualified_name);

CREATE TABLE IF NOT EXISTS ontology_registry.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  local_hash text NOT NULL CHECK (local_hash ~ '^[0-9a-f]{64}$'),
  active_hash text CHECK (active_hash IS NULL OR active_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('in_sync', 'drift', 'bootstrap_required', 'error')),
  drift jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ontology_registry_reconciliation_time_idx
  ON ontology_registry.reconciliation_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS epistemic.provenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  provenance_type text NOT NULL CHECK (provenance_type IN ('source', 'transformation', 'assertion', 'decision', 'action')),
  source_system text NOT NULL,
  source_reference text,
  activity_type text,
  agent_principal_id uuid REFERENCES iam.principals(id),
  derived_from uuid[] NOT NULL DEFAULT '{}'::uuid[],
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provenance_source_idx
  ON epistemic.provenance_records (tenant_id, source_system, source_reference);

CREATE TABLE IF NOT EXISTS audit.domain_events (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  producer text NOT NULL,
  actor_id uuid REFERENCES iam.principals(id),
  actor_service text,
  purpose text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  idempotency_key text NOT NULL,
  payload_schema_version text NOT NULL,
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  classification text NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, producer, idempotency_key)
);

CREATE INDEX IF NOT EXISTS domain_events_correlation_idx
  ON audit.domain_events (tenant_id, correlation_id, occurred_at);
CREATE INDEX IF NOT EXISTS domain_events_type_time_idx
  ON audit.domain_events (tenant_id, event_type, occurred_at);

ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS security_domain text NOT NULL DEFAULT 'company';
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active';
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now();
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS valid_to timestamptz;
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS source_system text NOT NULL DEFAULT 'legacy';
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS source_reference text;
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS ontology_version_id uuid REFERENCES ontology_registry.versions(id);
ALTER TABLE ontology.entities ADD COLUMN IF NOT EXISTS provenance_id uuid REFERENCES epistemic.provenance_records(id);

ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS security_domain text NOT NULL DEFAULT 'company';
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now();
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS valid_to timestamptz;
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS source_system text NOT NULL DEFAULT 'legacy';
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS source_reference text;
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS ontology_version_id uuid REFERENCES ontology_registry.versions(id);
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS provenance_id uuid REFERENCES epistemic.provenance_records(id);
ALTER TABLE ontology.relations ADD COLUMN IF NOT EXISTS confidence numeric(5,4)
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

CREATE INDEX IF NOT EXISTS entities_type_validity_idx
  ON ontology.entities (tenant_id, entity_type, lifecycle_status, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS entities_ontology_version_idx
  ON ontology.entities (tenant_id, ontology_version_id);
CREATE INDEX IF NOT EXISTS relations_type_validity_idx
  ON ontology.relations (tenant_id, relation_type, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS relations_ontology_version_idx
  ON ontology.relations (tenant_id, ontology_version_id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ontology_registry.versions',
    'ontology_registry.elements',
    'ontology_registry.reconciliation_runs',
    'epistemic.provenance_records',
    'audit.domain_events'
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

CREATE OR REPLACE VIEW ontology_runtime.objects
WITH (security_invoker = true)
AS
SELECT
  id AS object_id,
  tenant_id,
  entity_type AS object_type,
  external_key,
  display_name,
  schema_version,
  security_domain,
  classification,
  lifecycle_status,
  valid_from,
  valid_to,
  recorded_at,
  source_system,
  source_reference,
  ontology_version_id,
  provenance_id,
  attributes,
  version,
  created_by,
  created_at,
  updated_at
FROM ontology.entities;

CREATE OR REPLACE VIEW ontology_runtime.links
WITH (security_invoker = true)
AS
SELECT
  id AS link_id,
  tenant_id,
  relation_type AS link_type,
  from_entity_id AS from_object_id,
  to_entity_id AS to_object_id,
  schema_version,
  security_domain,
  valid_from,
  valid_to,
  recorded_at,
  source_system,
  source_reference,
  ontology_version_id,
  provenance_id,
  confidence,
  attributes,
  created_by,
  created_at
FROM ontology.relations;

CREATE OR REPLACE VIEW security.principals
WITH (security_invoker = true)
AS SELECT * FROM iam.principals;

CREATE OR REPLACE VIEW security.grants
WITH (security_invoker = true)
AS SELECT * FROM iam.grants;

CREATE OR REPLACE VIEW work.tasks
WITH (security_invoker = true)
AS SELECT * FROM workflow.tasks;

CREATE OR REPLACE VIEW work.task_events
WITH (security_invoker = true)
AS SELECT * FROM workflow.task_events;

CREATE OR REPLACE VIEW action.intents
WITH (security_invoker = true)
AS SELECT * FROM actions.intents;

GRANT USAGE ON SCHEMA ontology_registry, ontology_runtime, epistemic, decision, security, work, action
  TO ontology_app, ontology_readonly;
GRANT USAGE ON SCHEMA platform, ontology_registry, audit TO ontology_registry;

GRANT SELECT ON platform.tenants TO ontology_registry;
GRANT SELECT, INSERT, UPDATE ON ontology_registry.versions TO ontology_registry;
GRANT SELECT, INSERT ON ontology_registry.elements, ontology_registry.reconciliation_runs TO ontology_registry;
GRANT INSERT ON audit.events, audit.domain_events TO ontology_registry;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO ontology_registry;

GRANT SELECT ON ontology_registry.versions, ontology_registry.elements, ontology_registry.reconciliation_runs,
  epistemic.provenance_records, audit.domain_events,
  ontology_runtime.objects, ontology_runtime.links,
  security.principals, security.grants, work.tasks, work.task_events, action.intents
  TO ontology_readonly;

GRANT SELECT ON ontology_registry.versions, ontology_runtime.objects, ontology_runtime.links,
  epistemic.provenance_records, audit.domain_events
  TO ontology_app;
GRANT INSERT ON epistemic.provenance_records, audit.domain_events TO ontology_app;

REVOKE DELETE ON ontology_registry.versions, ontology_registry.elements, ontology_registry.reconciliation_runs,
  epistemic.provenance_records, audit.domain_events
  FROM ontology_app, ontology_readonly, ontology_registry, action_gateway;
REVOKE UPDATE, DELETE ON audit.domain_events FROM ontology_app, ontology_readonly, ontology_registry, action_gateway;

COMMIT;
