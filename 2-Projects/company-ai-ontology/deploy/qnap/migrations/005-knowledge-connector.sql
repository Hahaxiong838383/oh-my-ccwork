CREATE SCHEMA IF NOT EXISTS knowledge;

SELECT format(
  'CREATE ROLE knowledge_connector LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'knowledge_connector_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_connector')
\gexec

ALTER ROLE knowledge_connector PASSWORD :'knowledge_connector_password';

CREATE TABLE IF NOT EXISTS knowledge.resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  provider text NOT NULL DEFAULT 'feishu',
  resource_type text NOT NULL,
  external_key text NOT NULL,
  space_id text,
  parent_external_key text,
  title text NOT NULL,
  source_url text,
  classification text NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  acl_status text NOT NULL DEFAULT 'unknown' CHECK (acl_status IN ('known', 'unknown')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'skipped', 'deleted')),
  content_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_key)
);

CREATE TABLE IF NOT EXISTS knowledge.acl_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  resource_id uuid NOT NULL REFERENCES knowledge.resources(id) ON DELETE CASCADE,
  subject_type text NOT NULL
    CHECK (subject_type IN ('tenant', 'person', 'department', 'chat', 'group', 'wiki_space')),
  subject_key text NOT NULL,
  permission text NOT NULL DEFAULT 'read' CHECK (permission IN ('read')),
  source text NOT NULL DEFAULT 'feishu_acl',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, resource_id, subject_type, subject_key, permission)
);

CREATE TABLE IF NOT EXISTS knowledge.chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  resource_id uuid NOT NULL REFERENCES knowledge.resources(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, resource_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS knowledge.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  provider text NOT NULL DEFAULT 'feishu',
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS knowledge_resources_status_idx
  ON knowledge.resources (tenant_id, status, acl_status, resource_type, synced_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_acl_subject_idx
  ON knowledge.acl_entries (tenant_id, subject_type, subject_key, resource_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_resource_idx
  ON knowledge.chunks (tenant_id, resource_id, chunk_index);
CREATE INDEX IF NOT EXISTS knowledge_chunks_search_idx
  ON knowledge.chunks USING gin (search_vector);
CREATE INDEX IF NOT EXISTS knowledge_sync_runs_time_idx
  ON knowledge.sync_runs (tenant_id, started_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge.resources',
    'knowledge.acl_entries',
    'knowledge.chunks',
    'knowledge.sync_runs'
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

GRANT USAGE ON SCHEMA platform, knowledge, audit TO knowledge_connector;
GRANT SELECT ON platform.tenants TO knowledge_connector;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.resources, knowledge.acl_entries, knowledge.chunks TO knowledge_connector;
GRANT SELECT, INSERT, UPDATE ON knowledge.sync_runs TO knowledge_connector;
GRANT INSERT ON audit.events TO knowledge_connector;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA knowledge, audit TO knowledge_connector;

GRANT USAGE ON SCHEMA knowledge TO ontology_app, ontology_readonly;
GRANT SELECT ON knowledge.resources, knowledge.acl_entries, knowledge.chunks, knowledge.sync_runs TO ontology_app, ontology_readonly;

REVOKE DELETE ON knowledge.sync_runs FROM knowledge_connector, ontology_app, ontology_readonly;
