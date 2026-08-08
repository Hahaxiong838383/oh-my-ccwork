ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS dry_run_receipt jsonb;
ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS rollback_receipt jsonb;
ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS last_error text;

CREATE TABLE IF NOT EXISTS actions.demo_task_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  task_external_key text NOT NULL,
  remote_status text NOT NULL DEFAULT 'todo' CHECK (remote_status IN ('todo', 'in_progress', 'done')),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_external_key)
);

ALTER TABLE actions.demo_task_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions.demo_task_status FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'actions'
      AND tablename = 'demo_task_status'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON actions.demo_task_status
      USING (tenant_id = platform.current_tenant_id())
      WITH CHECK (tenant_id = platform.current_tenant_id());
  END IF;
END
$$;

INSERT INTO actions.demo_task_status (tenant_id, task_external_key, remote_status)
VALUES (:'tenant_id'::uuid, 'demo-p2-2026-001:task:demo-person-01', 'todo')
ON CONFLICT (tenant_id, task_external_key) DO NOTHING;

GRANT SELECT, UPDATE ON actions.demo_task_status TO action_gateway;
GRANT SELECT ON iam.grants TO action_gateway;
GRANT SELECT ON actions.demo_task_status TO ontology_readonly;
REVOKE ALL ON actions.demo_task_status FROM ontology_app;
REVOKE UPDATE, DELETE ON actions.intents FROM ontology_app, ontology_readonly;
