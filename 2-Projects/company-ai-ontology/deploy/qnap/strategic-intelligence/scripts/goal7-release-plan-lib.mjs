import fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

const REQUIRED_AUTHORIZATIONS = Object.freeze([
  'foundation_deployment',
  'migration_012_reconciliation',
  'service_recreation',
  'rollback_drill',
])
const TARGET_SERVICES = Object.freeze(['agent-core', 'knowledge-connector', 'h-lite'])
const UNAFFECTED_SERVICES = Object.freeze([
  'postgres',
  'redis',
  'qdrant',
  'ontology-registry',
  'action-gateway',
  'domain-connector',
  'gateway',
])
const ACCEPTANCE_STEPS = Object.freeze([
  'verify_runtime_release',
  'capture_pre_deployment_state',
  'backup_config_and_images',
  'reconcile_pre_existing_migration_012',
    'build_and_bind_three_candidate_images',
    'validate_preparation_evidence',
    'validate_migration_evidence',
  'wait_legacy_h_lite_quiet_window',
  'switch_h_lite_recovery_layer_and_verify',
  'drain_h_lite_and_agent_core',
  'switch_agent_core_and_verify',
  'switch_knowledge_connector_and_verify',
  'resume_h_lite_and_verify_zero_pending',
  'capture_post_deployment_state',
  'audit_zero_business_side_effects',
  'compile_deployment_evidence',
  'run_synthetic_authority_canary',
    'record_independent_owner_acceptance',
])
const ROLLBACK_TRIGGERS = Object.freeze([
  'target_service_health_timeout',
  'runtime_source_commit_mismatch',
  'active_schema_changed',
  'registry_not_in_sync',
  'foundation_restart_or_unhealthy_detected',
  'new_host_port_detected',
  'business_side_effect_detected',
  'drain_timeout_or_pending_delivery',
])
const CLOSED_CAPABILITIES = Object.freeze([
  'collectorStarted',
  'productionShadowStarted',
  'productResearchBulkImport',
  'formalP2Creation',
  'employeeDelivery',
  'erpWriteback',
  'socialWriteback',
  'causalActivation',
])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  requireValue(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label} fields mismatch`)
}

function exactArray(value, expected, label) {
  requireValue(Array.isArray(value) && isDeepStrictEqual(value, [...expected]), `${label} mismatch`)
}

function range(value, expected, label) {
  exactKeys(value, ['min', 'max'], label)
  requireValue(Number.isInteger(value.min) && Number.isInteger(value.max) && value.min >= 0 && value.max >= value.min, `${label} invalid`)
  requireValue(value.min === expected.min && value.max === expected.max, `${label} changed without release review`)
}

export function validateGoal7ReleasePlan(plan, scripts = {}) {
  exactKeys(plan, [
    'planVersion', 'goalKey', 'status', 'companyQnapIdentity', 'deploymentAuthorized',
    'migration012ReconciliationAuthorized', 'serviceRecreationAuthorized', 'rollbackDrillAuthorized',
    'requiredExplicitAuthorizations', 'targetServices', 'unaffectedServices', 'timing',
    'expectedImpacts', 'acceptanceSteps', 'rollbackTriggers', 'closedCapabilities',
  ], 'releasePlan')
  requireValue(plan.planVersion === '1.4.0', 'release plan version mismatch')
  requireValue(plan.goalKey === 'P1-PROD-READINESS', 'release plan goal mismatch')
  requireValue(plan.status === 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH', 'release plan status must remain waiting')
  requireValue(plan.companyQnapIdentity === 'qnap:company/prnas/TS-X65', 'release plan QNAP identity mismatch')
  for (const key of ['deploymentAuthorized', 'migration012ReconciliationAuthorized', 'serviceRecreationAuthorized', 'rollbackDrillAuthorized']) {
    requireValue(plan[key] === false, `${key} must remain false in Git`)
  }
  exactArray(plan.requiredExplicitAuthorizations, REQUIRED_AUTHORIZATIONS, 'requiredExplicitAuthorizations')
  exactArray(plan.targetServices, TARGET_SERVICES, 'targetServices')
  exactArray(plan.unaffectedServices, UNAFFECTED_SERVICES, 'unaffectedServices')

  exactKeys(plan.timing, [
    'preparationWindowMinutes', 'expectedUserVisibleInterruptionSeconds',
    'hardServiceHealthTimeoutSeconds', 'expectedRollbackMinutes', 'hardRollbackHealthTimeoutSeconds',
  ], 'timing')
  range(plan.timing.preparationWindowMinutes, { min: 8, max: 20 }, 'preparationWindowMinutes')
  range(plan.timing.expectedUserVisibleInterruptionSeconds, { min: 15, max: 120 }, 'expectedUserVisibleInterruptionSeconds')
  range(plan.timing.expectedRollbackMinutes, { min: 2, max: 6 }, 'expectedRollbackMinutes')
  requireValue(plan.timing.hardServiceHealthTimeoutSeconds === 180, 'hard service health timeout mismatch')
  requireValue(plan.timing.hardRollbackHealthTimeoutSeconds === 180, 'hard rollback health timeout mismatch')

  const expectedImpacts = [
    { capability: 'company_bot_reasoning', service: 'agent-core', impact: 'intermittent' },
    { capability: 'company_knowledge_retrieval', service: 'knowledge-connector', impact: 'intermittent' },
    { capability: 'company_feishu_bot_front_door', service: 'h-lite', impact: 'brief_reconnect' },
  ]
  requireValue(isDeepStrictEqual(plan.expectedImpacts, expectedImpacts), 'expected impacts mismatch')
  exactArray(plan.acceptanceSteps, ACCEPTANCE_STEPS, 'acceptanceSteps')
  exactArray(plan.rollbackTriggers, ROLLBACK_TRIGGERS, 'rollbackTriggers')
  exactKeys(plan.closedCapabilities, CLOSED_CAPABILITIES, 'closedCapabilities')
  for (const key of CLOSED_CAPABILITIES) requireValue(plan.closedCapabilities[key] === false, `${key} must remain closed`)

  if (scripts.prepare !== undefined) {
    const prepare = scripts.prepare
    requireValue(prepare.includes('GOAL7_DEPLOY_APPROVED'), 'preparation script missing authorization GOAL7_DEPLOY_APPROVED')
    requireValue(prepare.indexOf('GOAL7_DEPLOY_APPROVED') < prepare.indexOf('preflight-company-qnap.sh'), 'preparation authorization must precede QNAP preflight')
    requireValue(!prepare.includes('GOAL7_MIGRATION_012_RECONCILIATION_APPROVED') && !prepare.includes('GOAL7_SERVICE_RECREATION_APPROVED'), 'preparation script must not require later phase authorization')
    requireValue(prepare.includes('preparation-evidence.json'), 'preparation script missing bound evidence')
    requireValue(prepare.includes('goal7-candidate-$run_id'), 'preparation script missing candidate image tags')
    requireValue(prepare.includes('goal7-pre-$run_id'), 'preparation script missing previous image tags')
    requireValue(!/compose up|compose (restart|down|stop)/.test(prepare), 'preparation script contains service recreation')
    requireValue(!prepare.includes('compose exec -T postgres psql'), 'preparation script contains database migration')
  }
  if (scripts.migrate !== undefined) {
    const migrate = scripts.migrate
    requireValue(migrate.includes('GOAL7_MIGRATION_012_RECONCILIATION_APPROVED'), 'migration reconciliation script missing authorization GOAL7_MIGRATION_012_RECONCILIATION_APPROVED')
    requireValue(migrate.indexOf('GOAL7_MIGRATION_012_RECONCILIATION_APPROVED') < migrate.indexOf('preflight-company-qnap.sh'), 'migration reconciliation authorization must precede QNAP preflight')
    requireValue(!migrate.includes('GOAL7_DEPLOY_APPROVED') && !migrate.includes('GOAL7_SERVICE_RECREATION_APPROVED'), 'migration script must not require another phase authorization')
    requireValue(migrate.includes('validate-goal7-preparation.mjs'), 'migration script missing preparation evidence gate')
    requireValue(migrate.includes('migration-012-evidence.json'), 'migration script missing migration evidence')
    requireValue(migrate.includes('verify-goal7-migration-012-live.sh'), 'migration script missing live database verification')
    requireValue(migrate.includes('originalEvidenceStatus') && migrate.includes('missing_at_source'), 'migration reconciliation must disclose missing original evidence')
    requireValue(migrate.includes('database_sql_executed=0'), 'migration reconciliation must prove SQL was not replayed')
    requireValue(!migrate.includes('compose exec -T postgres psql --set=ON_ERROR_STOP=1'), 'migration reconciliation must not execute migration SQL')
    requireValue(!/compose up|compose build|compose (restart|down|stop)/.test(migrate), 'migration script contains service recreation')
  }
  if (scripts.verifyMigration !== undefined) {
    const verifyMigration = scripts.verifyMigration
    requireValue(verifyMigration.includes('ontology_app'), 'migration verifier missing real application role verification')
    requireValue(verifyMigration.includes('forced_rls_count') && verifyMigration.includes('tenant_policy_count'), 'migration verifier missing RLS verification')
    requireValue(verifyMigration.includes('delete_privilege_count') && verifyMigration.includes('banned_column_count'), 'migration verifier missing privilege or data-minimization checks')
    requireValue(!/compose up|compose build|compose (restart|down|stop)/.test(verifyMigration), 'migration verifier contains service recreation')
  }
  if (scripts.deploy !== undefined) {
    const deploy = scripts.deploy
    const mainPathStart = deploy.indexOf("wait_legacy_h_lite_quiet ||")
    const mainPath = mainPathStart >= 0 ? deploy.slice(mainPathStart) : ''
    requireValue(deploy.includes('GOAL7_SERVICE_RECREATION_APPROVED'), 'deployment script missing authorization GOAL7_SERVICE_RECREATION_APPROVED')
    requireValue(!deploy.includes('GOAL7_DEPLOY_APPROVED') && !deploy.includes('GOAL7_MIGRATION_012_RECONCILIATION_APPROVED'), 'service recreation script must not require earlier phase authorization')
    requireValue(deploy.indexOf('GOAL7_SERVICE_RECREATION_APPROVED') < deploy.indexOf('preflight-company-qnap.sh'), 'service authorization must precede QNAP preflight')
    requireValue(deploy.includes('validate-goal7-migration.mjs'), 'deployment missing migration evidence gate')
    requireValue(deploy.includes('preparation_evidence_sha256=') && deploy.includes('migration_evidence_sha256='), 'deployment manifest missing phase evidence hashes')
    requireValue(deploy.includes('attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2'), 'deployment health timeout changed')
    for (const service of ['agent-core', 'knowledge-connector', 'h-lite']) {
      requireValue((mainPath.match(new RegExp(`compose up -d --no-deps --no-build ${service}`, 'g')) || []).length === 1, `deployment must switch prebuilt ${service} exactly once on the main path`)
    }
    requireValue(mainPath.indexOf('compose up -d --no-deps --no-build h-lite') < mainPath.indexOf('compose up -d --no-deps --no-build agent-core'), 'recovery-capable H-Lite must switch before Agent Core')
    requireValue(deploy.includes('wait_legacy_h_lite_quiet'), 'deployment missing legacy H-Lite quiet gate')
    requireValue(deploy.includes('h_lite_admin drain 0'), 'deployment missing H-Lite drain gate')
    requireValue(deploy.includes('drain_agent_core'), 'deployment missing Agent Core drain gate')
    requireValue(deploy.includes('h_lite_admin resume 0'), 'deployment missing H-Lite resume gate')
    requireValue(deploy.includes('pendingDeliveries===0'), 'deployment missing pending delivery gate')
    requireValue(!/compose up -d (?!.*--no-deps --no-build)/.test(deploy), 'deployment service recreation must use --no-deps --no-build')
    requireValue(deploy.includes('compose up -d --no-deps --no-build "$service"'), 'deployment recovery path must reuse only prebuilt images without dependencies')
    requireValue(!/compose (restart|down|stop)/.test(deploy), 'deployment contains a broad service action')
    requireValue(!deploy.includes('compose exec -T postgres psql'), 'deployment script must not apply migration 012')
    requireValue(!/compose build/.test(deploy), 'deployment script must not rebuild candidate images')
  }
  if (scripts.rollback !== undefined) {
    const rollback = scripts.rollback
    requireValue(rollback.includes('GOAL7_ROLLBACK_APPROVED'), 'rollback script missing explicit authorization')
    requireValue(rollback.includes('[ "$attempt" -lt 90 ]'), 'rollback health timeout changed')
    requireValue(rollback.includes('h_lite_admin drain 1'), 'rollback missing H-Lite subscription drain gate')
    requireValue(rollback.includes('pendingDeliveries===0'), 'rollback missing pending delivery gate')
    requireValue(rollback.includes('127.0.0.1:8080/v1/admin/drain'), 'rollback missing Agent Core drain gate')
    requireValue(rollback.includes('compose up -d --no-deps --no-build "$service"'), 'rollback service recreation must use --no-deps')
    requireValue(!/DROP TABLE|DROP SCHEMA|012-goal7-authority-runtime\.sql/.test(rollback), 'rollback must retain additive migration 012')
  }

  return {
    status: plan.status,
    targetServiceCount: plan.targetServices.length,
    expectedUserVisibleInterruptionSeconds: plan.timing.expectedUserVisibleInterruptionSeconds,
    expectedRollbackMinutes: plan.timing.expectedRollbackMinutes,
    explicitAuthorizationCount: plan.requiredExplicitAuthorizations.length,
  }
}

export async function loadAndValidateGoal7ReleasePlan(planFile, scripts = {}) {
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'))
  return validateGoal7ReleasePlan(plan, scripts)
}
