BEGIN;

CREATE SCHEMA IF NOT EXISTS domain_read;

SELECT format('CREATE ROLE domain_connector LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'domain_connector_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'domain_connector')
\gexec
ALTER ROLE domain_connector PASSWORD :'domain_connector_password';

CREATE TABLE IF NOT EXISTS domain_read.source_cursors (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  source_system text NOT NULL,
  cursor_value text NOT NULL DEFAULT '',
  last_success_at timestamptz,
  last_run_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_system)
);

CREATE TABLE IF NOT EXISTS domain_read.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  source_system text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  cursor_before text,
  cursor_after text,
  replay boolean NOT NULL DEFAULT false,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE domain_read.source_cursors DROP CONSTRAINT IF EXISTS domain_read_source_cursors_last_run_fk;
ALTER TABLE domain_read.source_cursors ADD CONSTRAINT domain_read_source_cursors_last_run_fk FOREIGN KEY (last_run_id) REFERENCES domain_read.sync_runs(id);

CREATE TABLE IF NOT EXISTS domain_read.records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  source_system text NOT NULL,
  external_id text NOT NULL,
  object_type text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('active','expired','revoked','deleted','conflict')),
  epistemic_type text NOT NULL CHECK (epistemic_type IN ('source_fact','derived_fact','prediction','human_judgment')),
  confidence numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  authority text NOT NULL,
  purpose text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (tenant_id, source_system, external_id)
);

CREATE INDEX IF NOT EXISTS domain_read_records_type_time_idx ON domain_read.records(tenant_id, object_type, source_updated_at DESC);
CREATE INDEX IF NOT EXISTS domain_read_records_source_status_idx ON domain_read.records(tenant_id, source_system, status, source_updated_at DESC);

CREATE TABLE IF NOT EXISTS domain_read.dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  run_id uuid NOT NULL REFERENCES domain_read.sync_runs(id),
  source_system text NOT NULL,
  source_reference text,
  error_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['domain_read.source_cursors','domain_read.sync_runs','domain_read.records','domain_read.dead_letters'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=split_part(table_name,'.',1) AND tablename=split_part(table_name,'.',2) AND policyname='tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id=platform.current_tenant_id()) WITH CHECK (tenant_id=platform.current_tenant_id())', table_name);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE VIEW domain_read.erp_m3_v1 WITH (security_invoker=true) AS
SELECT id, tenant_id, external_id, object_type, source_updated_at, valid_from, valid_to, recorded_at, status, epistemic_type, authority, purpose, payload, provenance
FROM domain_read.records
WHERE source_system='aishike-erp-m3'
  AND (object_type LIKE 'domain.operations.%' OR object_type LIKE 'domain.device.%');

CREATE OR REPLACE VIEW domain_read.market_signal_v1 WITH (security_invoker=true) AS
SELECT id, tenant_id, external_id, object_type, source_updated_at, valid_from, valid_to, recorded_at, status, epistemic_type, confidence, authority, purpose, payload, provenance
FROM domain_read.records
WHERE source_system='kidshub-market' AND object_type LIKE 'domain.market.%';

REVOKE ALL ON SCHEMA domain_read FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA domain_read FROM PUBLIC;
GRANT USAGE ON SCHEMA domain_read TO domain_connector, ontology_app, ontology_readonly;
GRANT SELECT,INSERT,UPDATE ON domain_read.source_cursors,domain_read.sync_runs,domain_read.records,domain_read.dead_letters TO domain_connector;
GRANT SELECT ON domain_read.records TO ontology_app,ontology_readonly;
GRANT SELECT ON domain_read.erp_m3_v1,domain_read.market_signal_v1 TO domain_connector,ontology_app,ontology_readonly;
GRANT INSERT ON audit.events TO domain_connector;
GRANT USAGE ON SCHEMA audit,platform TO domain_connector;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO domain_connector;

COMMIT;
