BEGIN;

ALTER TABLE work.brain_cases
  DROP CONSTRAINT IF EXISTS brain_cases_status_check;

ALTER TABLE work.brain_cases
  ADD CONSTRAINT brain_cases_status_check CHECK (status IN (
    'received', 'scoped', 'authority_checked', 'evidence_collecting', 'evidence_ready',
    'synthesizing', 'response_ready', 'decision_pending', 'decision_approved',
    'planning', 'plan_ready', 'executing', 'verification_pending', 'verified', 'learning',
    'completed', 'clarification_required', 'permission_denied', 'blocked',
    'insufficient_evidence', 'review_required'
  ));

GRANT SELECT, INSERT, UPDATE ON actions.demo_task_status TO action_gateway;
REVOKE ALL ON actions.demo_task_status FROM ontology_app;

CREATE TABLE IF NOT EXISTS decision.cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  external_key text NOT NULL,
  work_case_id uuid,
  question_summary text NOT NULL CHECK (char_length(question_summary) <= 1000),
  purpose text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'scenario_ready', 'pending_approval', 'approved', 'rejected', 'superseded', 'closed'
  )),
  dri_id uuid NOT NULL REFERENCES iam.principals(id),
  evidence_package_id text,
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_key),
  FOREIGN KEY (tenant_id, work_case_id) REFERENCES work.brain_cases(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS decision.alternatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  decision_case_id uuid NOT NULL,
  external_key text NOT NULL,
  title text NOT NULL CHECK (char_length(title) <= 500),
  expected_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(risks) = 'array'),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'selected', 'rejected', 'withdrawn')),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, decision_case_id, external_key),
  FOREIGN KEY (tenant_id, decision_case_id) REFERENCES decision.cases(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS decision.scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  decision_case_id uuid NOT NULL,
  alternative_id uuid NOT NULL,
  external_key text NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions) = 'array'),
  projected_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  metric_impacts jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_score numeric(8,4) CHECK (risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 1)),
  status text NOT NULL DEFAULT 'modeled' CHECK (status IN ('modeled', 'selected', 'invalidated')),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, decision_case_id, external_key),
  FOREIGN KEY (tenant_id, decision_case_id) REFERENCES decision.cases(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, alternative_id) REFERENCES decision.alternatives(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS decision.decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  decision_case_id uuid NOT NULL,
  external_key text NOT NULL,
  selected_alternative_id uuid NOT NULL,
  rationale_summary text NOT NULL CHECK (char_length(rationale_summary) <= 2000),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'superseded', 'revoked')),
  approved_by uuid NOT NULL REFERENCES iam.principals(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  approval_evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(approval_evidence_references) = 'array'),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_key),
  UNIQUE (tenant_id, decision_case_id),
  FOREIGN KEY (tenant_id, decision_case_id) REFERENCES decision.cases(tenant_id, id),
  FOREIGN KEY (tenant_id, selected_alternative_id) REFERENCES decision.alternatives(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS decision.expected_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  decision_id uuid NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('decision', 'p2', 'task', 'action')),
  owner_reference text NOT NULL,
  metric_key text NOT NULL,
  target_operator text NOT NULL CHECK (target_operator IN ('eq', 'gte', 'lte', 'contains', 'status')),
  target_value numeric,
  target_text text,
  unit text,
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acceptance_criteria) = 'array'),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'missed', 'superseded')),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, decision_id, owner_type, owner_reference, metric_key),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES decision.decisions(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS decision.p2_bindings (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  decision_id uuid NOT NULL,
  p2_entity_id uuid NOT NULL REFERENCES ontology.entities(id),
  expected_outcome_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, decision_id, p2_entity_id),
  UNIQUE (tenant_id, p2_entity_id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES decision.decisions(tenant_id, id),
  FOREIGN KEY (tenant_id, expected_outcome_id) REFERENCES decision.expected_outcomes(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS decision.observed_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  expected_outcome_id uuid NOT NULL,
  source_system text NOT NULL,
  source_reference text,
  observed_value numeric,
  observed_text text,
  observed_status text NOT NULL CHECK (observed_status IN ('met', 'not_met', 'partial', 'unknown')),
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_references) = 'array'),
  confidence_level text NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low', 'insufficient')),
  observed_at timestamptz NOT NULL,
  valid_until timestamptz,
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, expected_outcome_id) REFERENCES decision.expected_outcomes(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS decision.verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  decision_id uuid NOT NULL,
  p2_entity_id uuid REFERENCES ontology.entities(id),
  task_id uuid REFERENCES workflow.tasks(id),
  action_intent_id uuid REFERENCES actions.intents(id),
  expected_outcome_id uuid NOT NULL,
  observed_outcome_id uuid NOT NULL,
  execution_success boolean NOT NULL,
  operational_success boolean NOT NULL,
  goal_success boolean NOT NULL,
  CHECK (NOT goal_success OR operational_success),
  execution_status text NOT NULL CHECK (execution_status IN ('success', 'failure', 'unknown')),
  operational_status text NOT NULL CHECK (operational_status IN ('success', 'failure', 'unknown')),
  goal_status text NOT NULL CHECK (goal_status IN ('achieved', 'missed', 'unknown')),
  evidence_references jsonb NOT NULL CHECK (jsonb_typeof(evidence_references) = 'array' AND jsonb_array_length(evidence_references) > 0),
  verification_status text NOT NULL DEFAULT 'completed' CHECK (verification_status IN ('pending', 'completed', 'review_required', 'invalidated')),
  verified_by uuid NOT NULL REFERENCES iam.principals(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, action_intent_id, expected_outcome_id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES decision.decisions(tenant_id, id),
  FOREIGN KEY (tenant_id, expected_outcome_id) REFERENCES decision.expected_outcomes(tenant_id, id),
  FOREIGN KEY (tenant_id, observed_outcome_id) REFERENCES decision.observed_outcomes(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS decision.learnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  verification_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  finding_summary text NOT NULL CHECK (char_length(finding_summary) <= 2000),
  cause_category text NOT NULL CHECK (cause_category IN ('assumption', 'execution', 'operation', 'market', 'measurement', 'unknown')),
  recommended_change jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_scope text NOT NULL CHECK (change_scope IN ('none', 'task', 'process', 'policy', 'ontology')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'reviewed', 'accepted', 'rejected')),
  reviewed_by uuid REFERENCES iam.principals(id),
  reviewed_at timestamptz,
  ontology_version_id uuid REFERENCES ontology_registry.versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, verification_id, finding_summary),
  FOREIGN KEY (tenant_id, verification_id) REFERENCES decision.verifications(tenant_id, id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES decision.decisions(tenant_id, id)
);

ALTER TABLE workflow.tasks ADD COLUMN IF NOT EXISTS decision_id uuid;
ALTER TABLE workflow.tasks ADD COLUMN IF NOT EXISTS expected_outcome_id uuid;
ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS decision_id uuid;
ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS task_id uuid;
ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS expected_outcome_id uuid;
ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS observed_outcome_id uuid;
ALTER TABLE actions.intents ADD COLUMN IF NOT EXISTS verification_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_tasks_tenant_id_id_key') THEN
    ALTER TABLE workflow.tasks ADD CONSTRAINT workflow_tasks_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_tenant_id_id_key') THEN
    ALTER TABLE actions.intents ADD CONSTRAINT action_intents_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_tasks_decision_fk') THEN
    ALTER TABLE workflow.tasks ADD CONSTRAINT workflow_tasks_decision_fk
      FOREIGN KEY (tenant_id, decision_id) REFERENCES decision.decisions(tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_tasks_expected_outcome_fk') THEN
    ALTER TABLE workflow.tasks ADD CONSTRAINT workflow_tasks_expected_outcome_fk
      FOREIGN KEY (tenant_id, expected_outcome_id) REFERENCES decision.expected_outcomes(tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_decision_fk') THEN
    ALTER TABLE actions.intents ADD CONSTRAINT action_intents_decision_fk
      FOREIGN KEY (tenant_id, decision_id) REFERENCES decision.decisions(tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_expected_outcome_fk') THEN
    ALTER TABLE actions.intents ADD CONSTRAINT action_intents_expected_outcome_fk
      FOREIGN KEY (tenant_id, expected_outcome_id) REFERENCES decision.expected_outcomes(tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_task_fk') THEN
    ALTER TABLE actions.intents ADD CONSTRAINT action_intents_task_fk
      FOREIGN KEY (tenant_id, task_id) REFERENCES workflow.tasks(tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_observed_outcome_fk') THEN
    ALTER TABLE actions.intents ADD CONSTRAINT action_intents_observed_outcome_fk
      FOREIGN KEY (tenant_id, observed_outcome_id) REFERENCES decision.observed_outcomes(tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_verification_fk') THEN
    ALTER TABLE actions.intents ADD CONSTRAINT action_intents_verification_fk
      FOREIGN KEY (tenant_id, verification_id) REFERENCES decision.verifications(tenant_id, id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS decision_cases_status_idx ON decision.cases (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS decision_alternatives_case_idx ON decision.alternatives (tenant_id, decision_case_id, status);
CREATE INDEX IF NOT EXISTS decision_scenarios_case_idx ON decision.scenarios (tenant_id, decision_case_id, status);
CREATE INDEX IF NOT EXISTS decision_expected_outcomes_status_idx ON decision.expected_outcomes (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS decision_observed_outcomes_time_idx ON decision.observed_outcomes (tenant_id, expected_outcome_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS decision_verifications_time_idx ON decision.verifications (tenant_id, decision_id, verified_at DESC);
CREATE INDEX IF NOT EXISTS decision_learnings_status_idx ON decision.learnings (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_tasks_decision_idx ON workflow.tasks (tenant_id, decision_id);
CREATE INDEX IF NOT EXISTS action_intents_decision_idx ON actions.intents (tenant_id, decision_id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'decision.cases',
    'decision.alternatives',
    'decision.scenarios',
    'decision.decisions',
    'decision.expected_outcomes',
    'decision.p2_bindings',
    'decision.observed_outcomes',
    'decision.verifications',
    'decision.learnings'
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

CREATE OR REPLACE FUNCTION decision.guard_p2_task_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_type text;
  decision_status text;
  outcome_decision_id uuid;
BEGIN
  SELECT entity_type INTO source_type FROM ontology.entities
   WHERE tenant_id = NEW.tenant_id AND id = NEW.source_entity_id;
  IF source_type = 'p2' AND (NEW.decision_id IS NULL OR NEW.expected_outcome_id IS NULL) THEN
    RAISE EXCEPTION 'P2 task requires approved decision and expected outcome' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision_id IS NOT NULL THEN
    SELECT status INTO decision_status FROM decision.decisions
     WHERE tenant_id = NEW.tenant_id AND id = NEW.decision_id;
    IF decision_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'task decision is not approved' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.expected_outcome_id IS NOT NULL THEN
    SELECT decision_id INTO outcome_decision_id FROM decision.expected_outcomes
     WHERE tenant_id = NEW.tenant_id AND id = NEW.expected_outcome_id;
    IF outcome_decision_id IS NULL OR outcome_decision_id IS DISTINCT FROM NEW.decision_id THEN
      RAISE EXCEPTION 'task expected outcome does not belong to decision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS workflow_tasks_require_approved_decision ON workflow.tasks;
CREATE TRIGGER workflow_tasks_require_approved_decision
BEFORE INSERT OR UPDATE OF decision_id, source_entity_id ON workflow.tasks
FOR EACH ROW EXECUTE FUNCTION decision.guard_p2_task_decision();

CREATE OR REPLACE FUNCTION decision.guard_decision_dri()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  case_dri_id uuid;
BEGIN
  SELECT dri_id INTO case_dri_id FROM decision.cases
   WHERE tenant_id = NEW.tenant_id AND id = NEW.decision_case_id;
  IF case_dri_id IS NULL OR NEW.approved_by IS DISTINCT FROM case_dri_id THEN
    RAISE EXCEPTION 'only decision case DRI can approve decision' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM iam.grants
     WHERE tenant_id = NEW.tenant_id AND principal_id = NEW.approved_by
       AND resource_scope = 'workflow:p2' AND permission = 'approve'
       AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RAISE EXCEPTION 'decision DRI lacks active approval grant' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS decision_requires_case_dri ON decision.decisions;
CREATE TRIGGER decision_requires_case_dri
BEFORE INSERT OR UPDATE OF approved_by, decision_case_id ON decision.decisions
FOR EACH ROW EXECUTE FUNCTION decision.guard_decision_dri();

CREATE OR REPLACE FUNCTION decision.guard_action_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_decision_id uuid;
  task_outcome_id uuid;
BEGIN
  IF NEW.decision_id IS NULL AND NEW.task_id IS NULL AND NEW.expected_outcome_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.decision_id IS NULL OR NEW.task_id IS NULL OR NEW.expected_outcome_id IS NULL THEN
    RAISE EXCEPTION 'governed action requires decision, task, and expected outcome' USING ERRCODE = '23514';
  END IF;
  SELECT decision_id, expected_outcome_id INTO task_decision_id, task_outcome_id
    FROM workflow.tasks
   WHERE tenant_id = NEW.tenant_id AND id = NEW.task_id;
  IF task_decision_id IS DISTINCT FROM NEW.decision_id OR task_outcome_id IS DISTINCT FROM NEW.expected_outcome_id THEN
    RAISE EXCEPTION 'action lineage does not match task lineage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS action_intents_require_consistent_lineage ON actions.intents;
CREATE TRIGGER action_intents_require_consistent_lineage
BEFORE INSERT OR UPDATE OF decision_id, task_id, expected_outcome_id ON actions.intents
FOR EACH ROW EXECUTE FUNCTION decision.guard_action_lineage();

CREATE OR REPLACE FUNCTION decision.guard_approved_decision_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved' AND (
    NEW.decision_case_id IS DISTINCT FROM OLD.decision_case_id OR
    NEW.selected_alternative_id IS DISTINCT FROM OLD.selected_alternative_id OR
    NEW.rationale_summary IS DISTINCT FROM OLD.rationale_summary OR
    NEW.approved_by IS DISTINCT FROM OLD.approved_by OR
    NEW.approved_at IS DISTINCT FROM OLD.approved_at
  ) THEN
    RAISE EXCEPTION 'approved decision core fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS decision_approved_core_immutable ON decision.decisions;
CREATE TRIGGER decision_approved_core_immutable
BEFORE UPDATE ON decision.decisions
FOR EACH ROW EXECUTE FUNCTION decision.guard_approved_decision_immutable();

CREATE OR REPLACE FUNCTION decision.guard_completed_verification_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.verification_status = 'completed' THEN
    RAISE EXCEPTION 'completed verification is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS decision_completed_verification_immutable ON decision.verifications;
CREATE TRIGGER decision_completed_verification_immutable
BEFORE UPDATE OR DELETE ON decision.verifications
FOR EACH ROW EXECUTE FUNCTION decision.guard_completed_verification_immutable();

CREATE OR REPLACE FUNCTION decision.guard_learning_verification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  verified_decision_id uuid;
  verified_status text;
BEGIN
  SELECT decision_id, verification_status INTO verified_decision_id, verified_status
    FROM decision.verifications
   WHERE tenant_id = NEW.tenant_id AND id = NEW.verification_id;
  IF verified_status IS DISTINCT FROM 'completed' OR verified_decision_id IS DISTINCT FROM NEW.decision_id THEN
    RAISE EXCEPTION 'learning requires completed verification for the same decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS decision_learning_requires_completed_verification ON decision.learnings;
CREATE TRIGGER decision_learning_requires_completed_verification
BEFORE INSERT OR UPDATE OF verification_id, decision_id ON decision.learnings
FOR EACH ROW EXECUTE FUNCTION decision.guard_learning_verification();

CREATE OR REPLACE VIEW decision.lineage_v1
WITH (security_invoker = true)
AS
WITH task_summary AS (
  SELECT tenant_id, decision_id,
         count(*)::integer AS task_count,
         count(*) FILTER (WHERE status = 'accepted')::integer AS accepted_task_count
    FROM workflow.tasks
   WHERE decision_id IS NOT NULL
   GROUP BY tenant_id, decision_id
), action_summary AS (
  SELECT tenant_id, decision_id, count(*)::integer AS action_count
    FROM actions.intents
   WHERE decision_id IS NOT NULL
   GROUP BY tenant_id, decision_id
), verification_summary AS (
  SELECT tenant_id, decision_id,
         count(*)::integer AS verification_count,
         bool_or(execution_success) AS execution_success,
         bool_or(operational_success) AS operational_success,
         bool_or(goal_success) AS goal_success,
         max(verified_at) AS last_verified_at
    FROM decision.verifications
   GROUP BY tenant_id, decision_id
), learning_summary AS (
  SELECT tenant_id, decision_id,
         count(*)::integer AS learning_count,
         max(created_at) AS last_learning_at
    FROM decision.learnings
   GROUP BY tenant_id, decision_id
)
SELECT
  dc.tenant_id,
  dc.id AS decision_case_id,
  dc.external_key AS decision_case_external_key,
  dc.question_summary,
  dc.status AS decision_case_status,
  dc.work_case_id,
  d.id AS decision_id,
  d.external_key AS decision_external_key,
  d.status AS decision_status,
  selected.external_key AS selected_alternative_external_key,
  p2.id AS p2_entity_id,
  p2.external_key AS p2_external_key,
  p2.display_name AS p2_title,
  coalesce(task_summary.task_count, 0) AS task_count,
  coalesce(task_summary.accepted_task_count, 0) AS accepted_task_count,
  coalesce(action_summary.action_count, 0) AS action_count,
  coalesce(verification_summary.verification_count, 0) AS verification_count,
  coalesce(learning_summary.learning_count, 0) AS learning_count,
  verification_summary.execution_success,
  verification_summary.operational_success,
  verification_summary.goal_success,
  verification_summary.last_verified_at,
  learning_summary.last_learning_at,
  dc.created_at,
  dc.updated_at
FROM decision.cases dc
LEFT JOIN decision.decisions d
  ON d.tenant_id = dc.tenant_id AND d.decision_case_id = dc.id
LEFT JOIN decision.alternatives selected
  ON selected.tenant_id = d.tenant_id AND selected.id = d.selected_alternative_id
LEFT JOIN decision.p2_bindings binding
  ON binding.tenant_id = d.tenant_id AND binding.decision_id = d.id
LEFT JOIN ontology.entities p2
  ON p2.tenant_id = binding.tenant_id AND p2.id = binding.p2_entity_id
LEFT JOIN task_summary
  ON task_summary.tenant_id = d.tenant_id AND task_summary.decision_id = d.id
LEFT JOIN action_summary
  ON action_summary.tenant_id = d.tenant_id AND action_summary.decision_id = d.id
LEFT JOIN verification_summary
  ON verification_summary.tenant_id = d.tenant_id AND verification_summary.decision_id = d.id
LEFT JOIN learning_summary
  ON learning_summary.tenant_id = d.tenant_id AND learning_summary.decision_id = d.id;

CREATE OR REPLACE VIEW decision.practice_status_v1
WITH (security_invoker = true)
AS
SELECT
  lineage.*,
  CASE
    WHEN lineage.decision_case_status IN ('rejected', 'superseded', 'closed') THEN 'retired'
    WHEN lineage.decision_status IN ('superseded', 'revoked') THEN 'retired'
    WHEN lineage.decision_status IS NULL THEN 'decision_pending'
    WHEN lineage.p2_entity_id IS NULL THEN 'plan_pending'
    WHEN lineage.task_count = 0 THEN 'plan_pending'
    WHEN lineage.action_count = 0 THEN 'execution_pending'
    WHEN lineage.verification_count = 0 THEN 'verification_pending'
    WHEN lineage.learning_count = 0 THEN 'learning_pending'
    WHEN lineage.goal_success IS TRUE THEN 'goal_verified'
    ELSE 'learning_recorded'
  END AS practice_status
FROM decision.lineage_v1 lineage;

GRANT USAGE ON SCHEMA decision TO ontology_app, ontology_readonly, action_gateway;

GRANT SELECT, INSERT, UPDATE ON
  decision.cases,
  decision.alternatives,
  decision.scenarios,
  decision.decisions,
  decision.expected_outcomes,
  decision.p2_bindings,
  decision.learnings
TO ontology_app;

GRANT SELECT ON
  decision.observed_outcomes,
  decision.verifications,
  decision.lineage_v1,
  decision.practice_status_v1
TO ontology_app;

GRANT SELECT ON ALL TABLES IN SCHEMA decision TO ontology_readonly;
GRANT SELECT ON decision.decisions, decision.expected_outcomes, decision.p2_bindings TO action_gateway;
GRANT SELECT, INSERT ON decision.observed_outcomes, decision.verifications TO action_gateway;
GRANT UPDATE (status, updated_at) ON decision.expected_outcomes TO action_gateway;
GRANT USAGE ON SCHEMA ontology_registry TO action_gateway;
GRANT SELECT ON ontology_registry.versions TO action_gateway;

REVOKE DELETE ON ALL TABLES IN SCHEMA decision FROM ontology_app, ontology_readonly, action_gateway;
REVOKE UPDATE ON decision.observed_outcomes, decision.verifications FROM ontology_app, ontology_readonly, action_gateway;
REVOKE UPDATE, DELETE ON decision.decisions FROM action_gateway;
REVOKE UPDATE, DELETE ON workflow.tasks FROM action_gateway;
REVOKE UPDATE, DELETE ON actions.intents FROM ontology_app, ontology_readonly;

COMMIT;
