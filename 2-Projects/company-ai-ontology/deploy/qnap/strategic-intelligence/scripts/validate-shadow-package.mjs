#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compose = JSON.parse(await fs.readFile(path.join(root, 'docker-compose.shadow.yml'), 'utf8'))
const policy = JSON.parse(await fs.readFile(path.join(root, 'config/shadow-policy.json'), 'utf8'))
const daySchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/shadow-day-evidence.schema.json'), 'utf8'))
const sevenDaySchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/seven-day-shadow-summary.schema.json'), 'utf8'))
const reviewerRoleAccessSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/reviewer-role-access-acceptance.schema.json'), 'utf8'))
const reviewerRoleAccessTemplate = JSON.parse(await fs.readFile(path.join(root, 'config/reviewer-role-access-acceptance.template.json'), 'utf8'))
const goal7WorkerReadbackSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/goal7-worker-readback.schema.json'), 'utf8'))
const goal7WorkerReadbackTemplate = JSON.parse(await fs.readFile(path.join(root, 'config/goal7-worker-readback.template.json'), 'utf8'))
const goal7OwnerAcceptanceSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/goal7-owner-acceptance.schema.json'), 'utf8'))
const goal7OwnerAcceptanceTemplate = JSON.parse(await fs.readFile(path.join(root, 'config/goal7-owner-acceptance.template.json'), 'utf8'))
const goal7AcceptanceSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/goal7-acceptance-evidence.schema.json'), 'utf8'))
const goal7AcceptanceTemplate = JSON.parse(await fs.readFile(path.join(root, 'config/goal7-acceptance.template.json'), 'utf8'))
const goalCompletionSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/goal-completion-evidence.schema.json'), 'utf8'))
const goalCompletionTemplate = JSON.parse(await fs.readFile(path.join(root, 'config/goal-completion-evidence.template.json'), 'utf8'))
const goalRuntimeSnapshotSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/goal-runtime-snapshot.schema.json'), 'utf8'))
const goalRuntimeSnapshotTemplate = JSON.parse(await fs.readFile(path.join(root, 'config/goal-runtime-snapshot.template.json'), 'utf8'))
const domainBatchSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/shadow-domain-batch.schema.json'), 'utf8'))
const internalRunEvidenceSchema = JSON.parse(await fs.readFile(path.join(root, 'schemas/internal-engineering-run-evidence.schema.json'), 'utf8'))
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const envExample = await fs.readFile(path.join(root, 'config/env.shadow.example'), 'utf8')
const runtimeWorkflow = await fs.readFile(path.resolve(root, '../../../../..', '.github/workflows/p1-si-runtime-verify.yml'), 'utf8')
const errors = []
if (goal7AcceptanceSchema.properties?.evidenceVersion?.const !== '3.0.0') errors.push('Goal 7 acceptance schema must bind rollback drill evidence')
if (goal7AcceptanceTemplate.status !== 'pending' || goal7AcceptanceTemplate.ownerAccepted !== false) errors.push('Goal 7 acceptance template must remain pending')
if (goal7WorkerReadbackSchema.properties?.evidenceVersion?.const !== '2.0.0') errors.push('Goal 7 worker readback schema must be compiler-derived v2')
if (goal7WorkerReadbackTemplate.productionReady !== false || Object.keys(goal7WorkerReadbackTemplate.rawEvidenceFiles || {}).length !== 0) errors.push('Goal 7 worker readback template must remain non-acceptable')
if (goal7OwnerAcceptanceSchema.properties?.evidenceVersion?.const !== '3.0.0') errors.push('Goal 7 owner acceptance schema must bind rollback drill evidence')
if (goal7OwnerAcceptanceTemplate.accepted !== false || Object.keys(goal7OwnerAcceptanceTemplate.engineeringEvidenceFiles || {}).length !== 0) errors.push('Goal 7 owner acceptance template must remain non-acceptable')
if (reviewerRoleAccessSchema.properties?.evidenceVersion?.const !== '2.0.0') errors.push('reviewer role access schema must be compiler-derived v2')
for (const name of [
  'goal7-worker-http-response.schema.json',
  'goal7-worker-ledger-row.schema.json',
  'goal7-worker-readback.schema.json',
  'goal7-authority-canary.schema.json',
  'goal7-deployment-evidence.schema.json',
  'goal7-deployment-state.schema.json',
  'goal7-rollback-drill-evidence.schema.json',
  'goal7-foundation-release-plan.schema.json',
  'goal7-owner-acceptance.schema.json',
]) await fs.access(path.join(root, 'schemas', name)).catch(() => errors.push(`missing Goal 7 schema ${name}`))
for (const name of ['reviewer-role-member-session.schema.json', 'reviewer-role-security-owner-acceptance.schema.json']) {
  await fs.access(path.join(root, 'schemas', name)).catch(() => errors.push(`missing reviewer role evidence schema ${name}`))
}
for (const name of [
  'goal7-worker-readback.template.json',
  'goal7-authority-canary.template.json',
  'goal7-deployment-evidence.template.json',
  'goal7-deployment-state.template.json',
  'goal7-owner-acceptance.template.json',
]) await fs.access(path.join(root, 'config', name)).catch(() => errors.push(`missing Goal 7 template ${name}`))
await fs.access(path.join(root, 'config/goal7-foundation-release-plan.json')).catch(() => errors.push('missing Goal 7 foundation release plan'))
for (const name of ['reviewer-role-member-session.template.json', 'reviewer-role-security-owner-acceptance.template.json']) {
  await fs.access(path.join(root, 'config', name)).catch(() => errors.push(`missing reviewer role evidence template ${name}`))
}
for (const name of ['goal7-evidence-lib.mjs', 'goal7-worker-readback-lib.mjs', 'goal7-deployment-lib.mjs', 'goal7-rollback-drill-lib.mjs', 'goal7-runtime-release-lib.mjs', 'goal7-release-plan-lib.mjs', 'goal7-phase-evidence-lib.mjs', 'validate-goal7-runtime-release.mjs', 'validate-goal7-release-plan.mjs', 'validate-goal7-preparation.mjs', 'validate-goal7-migration.mjs', 'write-goal7-preparation-evidence.mjs', 'write-goal7-migration-evidence.mjs', 'hash-goal7-runtime-tree.mjs', 'compile-goal7-worker-readback.mjs', 'validate-goal7-worker-readback.mjs', 'record-goal7-owner-acceptance.mjs', 'compile-goal7-deployment-evidence.mjs', 'validate-goal7-deployment-evidence.mjs', 'compile-goal7-rollback-drill.mjs', 'validate-goal7-rollback-drill.mjs', 'compile-goal7-acceptance.mjs', 'validate-goal7-acceptance.mjs', 'capture-goal7-deployment-state.sh', 'prepare-goal7-foundation.sh', 'reconcile-goal7-migration-012.sh', 'verify-goal7-migration-012-live.sh', 'deploy-goal7-foundation.sh', 'rollback-goal7-foundation.sh']) {
  await fs.access(path.join(root, 'scripts', name)).catch(() => errors.push(`missing Goal 7 evidence compiler file ${name}`))
}
for (const name of ['goal7-worker-readback-seed.sql', 'goal7-worker-readback-ledger.sql', 'goal7-worker-readback-cleanup.sql']) {
  await fs.access(path.resolve(root, '..', 'canary', name)).catch(() => errors.push(`missing Goal 7 worker readback SQL ${name}`))
}
const workerReadbackRunner = await fs.readFile(path.resolve(root, '..', 'scripts/run-goal7-worker-readback.sh'), 'utf8').catch(() => '')
for (const marker of ['GOAL7_WORKER_READBACK_APPROVED', 'preflight-company-qnap.sh', 'worker-http-response.json', 'worker-ledger-row.json', 'compile-goal7-worker-readback.mjs', 'h-lite node --input-type=module', 'createCompanyAgentCoreAdapter', 'goal7-worker-readback-ledger.sql']) {
  if (!workerReadbackRunner.includes(marker)) errors.push(`Goal 7 worker readback runner missing ${marker}`)
}
const internalPlanValidation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-internal-engineering-shadow-plan.mjs')], { encoding: 'utf8' })
if (internalPlanValidation.status !== 0) errors.push('internal engineering plan must validate')
const allowedServices = new Set(['intelligence-orchestrator', 'intelligence-collector'])
for (const name of Object.keys(compose.services || {})) {
  if (!allowedServices.has(name)) errors.push(`unexpected service ${name}`)
}
for (const [name, service] of Object.entries(compose.services || {})) {
  if (service.ports || service.expose) errors.push(`${name} publishes a port`)
  if (service.privileged) errors.push(`${name} is privileged`)
  if (!service.read_only) errors.push(`${name} root filesystem is writable`)
  if (!service.cap_drop?.includes('ALL')) errors.push(`${name} does not drop all capabilities`)
  if (!service.security_opt?.includes('no-new-privileges:true')) errors.push(`${name} lacks no-new-privileges`)
  if ((service.volumes || []).some((value) => value.includes('docker.sock'))) errors.push(`${name} mounts docker socket`)
  for (const [key, value] of Object.entries(service.environment || {})) {
    if (/(PUBLISH|FORMAL_P2_ENABLED|EMPLOYEE_DELIVERY_ENABLED|ERP_WRITEBACK_ENABLED|SOCIAL_WRITEBACK_ENABLED|CAUSAL_ACTIVATION_ENABLED)/.test(key) && value !== 'false') {
      errors.push(`${name} enables forbidden side effect ${key}`)
    }
  }
}
const collector = compose.services['intelligence-collector']
const orchestrator = compose.services['intelligence-orchestrator']
if (orchestrator.user !== '${SI_ORCHESTRATOR_UID:-10003}:${SI_ORCHESTRATOR_GID:-10003}') errors.push('orchestrator must use the configured non-root runtime identity')
if (collector.user !== '${SI_COLLECTOR_UID:-10001}:${SI_COLLECTOR_GID:-10001}') errors.push('collector must use the configured non-root runtime identity')
if (collector.cpus !== 0.5) errors.push('collector CPU limit must be 0.5')
if (collector.mem_limit !== '512m') errors.push('collector memory limit must be 512m')
if (collector.restart !== 'no') errors.push('collector restart must be no')
if (!collector.profiles?.includes('worker')) errors.push('collector must be an on-demand worker profile')
if (!String(collector.image).includes('sha256')) errors.push('collector image variable must require an immutable digest')
if (policy.publish !== false || policy.deploymentMode !== 'shadow') errors.push('policy must remain shadow publish=false')
if (policy.requiredConsecutiveNaturalDays !== 7) errors.push('shadow evidence must require seven natural days')
if (!daySchema.required?.includes('simulated') || daySchema.properties?.simulated?.const !== false) errors.push('day evidence must require simulated=false')
if (!daySchema.required?.includes('publish') || daySchema.properties?.publish?.const !== false) errors.push('day evidence must require publish=false')
if (!daySchema.required?.includes('domainArtifacts') || !daySchema.required?.includes('coverage')) errors.push('day evidence must require domain artifacts and coverage')
if (!daySchema.properties?.coverage?.required?.includes('domainCompilationCompleted')) errors.push('day evidence must require domain compilation coverage')
if (!daySchema.properties?.coverage?.required?.includes('domainPersistenceCompleted')) errors.push('day evidence must require domain persistence coverage')
if (!daySchema.properties?.domainArtifacts?.required?.includes('persistenceState')) errors.push('day evidence must require domain persistence state')
if (sevenDaySchema.properties?.completedNaturalDays?.const !== 7) errors.push('seven-day summary must require seven completed natural days')
if (sevenDaySchema.properties?.engineeringVerified?.const !== true) errors.push('seven-day summary must require engineering verification')
if (reviewerRoleAccessSchema.properties?.workbenchKey?.const !== 'P1-SI-HUMAN-REVIEW') errors.push('reviewer role access schema workbench mismatch')
if (reviewerRoleAccessTemplate.status !== 'pending' || reviewerRoleAccessTemplate.memberExperienceVerified !== false) errors.push('reviewer role access template must fail closed')
if (reviewerRoleAccessTemplate.roleTests?.length !== 0) errors.push('reviewer role access template must not contain fabricated member sessions')
if (goalCompletionSchema.properties?.status?.const !== 'complete') errors.push('goal completion schema must require complete status')
if (goalCompletionSchema.properties?.deploymentMode?.const !== 'production_shadow') errors.push('goal completion schema must require production shadow')
if (goalCompletionSchema.properties?.companyQnap?.properties?.host?.const !== 'PRNas') errors.push('goal completion schema company QNAP host mismatch')
if (goalCompletionSchema.properties?.sevenDay?.properties?.completedNaturalDays?.const !== 7) errors.push('goal completion schema must require seven natural days')
if (goalCompletionTemplate.status !== 'pending' || goalCompletionTemplate.releaseIdentity !== null) errors.push('goal completion template must fail closed')
if (!goalRuntimeSnapshotSchema.properties?.phase?.enum?.includes('pre_deployment') || !goalRuntimeSnapshotSchema.properties?.phase?.enum?.includes('post_seven_day')) errors.push('goal runtime snapshot schema must cover pre and post phases')
if (goalRuntimeSnapshotSchema.properties?.activeOntology?.properties?.schemaVersion?.const !== '3.3.0') errors.push('goal runtime snapshot schema must preserve active schema 3.3.0')
if (goalRuntimeSnapshotTemplate.phase !== 'pending' || goalRuntimeSnapshotTemplate.activeOntology !== null) errors.push('goal runtime snapshot template must fail closed')
if (domainBatchSchema.properties?.publish?.const !== false) errors.push('domain batch schema must require publish=false')
if (domainBatchSchema.properties?.persistenceState?.const !== 'json_candidate_pending_postgres') errors.push('domain batch must disclose pending Postgres persistence')
if (!domainBatchSchema.required?.includes('ingestionRun')) errors.push('domain batch must require ingestion run provenance')
if (internalRunEvidenceSchema.properties?.operationMode?.const !== 'internal_engineering_shadow') errors.push('internal run evidence operation mode mismatch')
if (internalRunEvidenceSchema.properties?.countsTowardProductionShadow?.const !== false) errors.push('internal run evidence must not count toward production Shadow')
if (internalRunEvidenceSchema.properties?.acceptance?.properties?.eligibleForProductionShadow?.const !== false) errors.push('internal run evidence must never be production eligible')
for (const name of ['shadow:compile-seven-day', 'shadow:record-owner-acceptance', 'shadow:validate-seven-day']) {
  if (!packageJson.scripts?.[name]) errors.push(`missing package script ${name}`)
}
for (const name of ['goal:validate-deployment-evidence', 'goal:validate-runtime-snapshot', 'goal:compile-completion-evidence', 'goal:completion']) {
  if (!packageJson.scripts?.[name]) errors.push(`missing package script ${name}`)
}
for (const name of ['internal:compile-run-evidence', 'internal:validate-run-evidence']) {
  if (!packageJson.scripts?.[name]) errors.push(`missing package script ${name}`)
}
for (const name of ['goal7:compile-worker-readback', 'goal7:validate-worker-readback', 'goal7:record-owner-acceptance', 'goal7:compile-acceptance', 'goal7:validate-acceptance']) {
  if (!packageJson.scripts?.[name]) errors.push(`missing package script ${name}`)
}
for (const name of [
  'snapshot-last-good.mjs',
  'prepare-revocation-audit-fixture.mjs',
  'run-source-revocation-audit.sh',
  'capture-shadow-side-effects.sh',
  'compile-shadow-run-audit.mjs',
  'compile-shadow-domain-batch.mjs',
  'validate-shadow-domain-batch.mjs',
  'compile-shadow-domain-sql.mjs',
  'persist-shadow-domain-batch.sh',
  'node-runtime.sh',
  'capture-internal-engineering-runtime-state.sh',
  'compile-internal-engineering-run-evidence.mjs',
  'validate-internal-engineering-run-evidence.mjs',
]) {
  await fs.access(path.join(root, 'scripts', name)).catch(() => errors.push(`missing runtime audit script ${name}`))
}
await fs.access(path.join(root, 'test/fixtures/write-shadow-domain-runtime-fixture.mjs')).catch(() => errors.push('missing domain runtime fixture generator'))
const dispatcher = await fs.readFile(path.join(root, 'scripts/dispatch-next.sh'), 'utf8')
for (const marker of ['run-source-revocation-audit.sh', 'capture-shadow-side-effects.sh', 'compile-shadow-run-audit.mjs', 'compile-shadow-domain-batch.mjs', 'validate-shadow-domain-batch.mjs', 'persist-shadow-domain-batch.sh', '--domain-batch', '--audit-metrics-file', '--domain-metrics-file', 'SI_P003_REVIEW_FILE']) {
  if (!dispatcher.includes(marker)) errors.push(`dispatcher missing runtime audit marker ${marker}`)
}
for (const name of ['shadow:validate-domain', 'shadow:compile-domain-sql']) {
  if (!packageJson.scripts?.[name]) errors.push(`missing package script ${name}`)
}
for (const name of ['goal7:compile-acceptance', 'goal7:validate-acceptance', 'goal7:validate-runtime-release', 'goal7:validate-release-plan']) {
  if (!packageJson.scripts?.[name]) errors.push(`missing package script ${name}`)
}
if (!packageJson.scripts?.['reviewer-role:compile-acceptance']) errors.push('missing reviewer role acceptance compiler script')
for (const name of ['reviewer-role-access-lib.mjs', 'compile-reviewer-role-access-acceptance.mjs', 'validate-reviewer-role-access-acceptance.mjs']) {
  await fs.access(path.join(root, 'scripts', name)).catch(() => errors.push(`missing reviewer role evidence compiler file ${name}`))
}
const goal7ReleasePlanValidation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-goal7-release-plan.mjs')], { encoding: 'utf8' })
if (goal7ReleasePlanValidation.status !== 0) errors.push('Goal 7 foundation release plan must validate')
const qnapHostNodeScripts = [
  'deploy-shadow.sh',
  'apply-shadow-migrations.sh',
  'dispatch-next.sh',
  'persist-shadow-domain-batch.sh',
  'run-source-revocation-audit.sh',
  'capture-shadow-side-effects.sh',
  'deploy-internal-engineering-shadow.sh',
  'run-internal-engineering-once.sh',
  'capture-internal-engineering-runtime-state.sh',
  'capture-goal7-deployment-state.sh',
  'prepare-goal7-foundation.sh',
  'reconcile-goal7-migration-012.sh',
  'deploy-goal7-foundation.sh',
]
for (const name of qnapHostNodeScripts) {
  const script = await fs.readFile(path.join(root, 'scripts', name), 'utf8')
  if (!script.includes('NODE_BIN') || !script.includes('node-runtime.sh')) errors.push(`${name} must use the QNAP Node runtime adapter`)
  if (/(^|[;&|][ \t]*|\$\()[ \t]*node(?:[ \t]|$)/m.test(script)) errors.push(`${name} still invokes host node directly`)
}
if (dispatcher.indexOf('. "$env_file"') > dispatcher.indexOf('validate-request.mjs')) errors.push('dispatcher must load the protected env before the first Node invocation')
if (!envExample.includes('SI_NODE_RUNTIME_IMAGE=sha256:')) errors.push('shadow env example must require an immutable Node runtime image')
const productionDeploy = await fs.readFile(path.join(root, 'scripts/deploy-shadow.sh'), 'utf8')
for (const marker of ['SI_NODE_RUNTIME_IMAGE is required', 'approval files must be staged inside the strategic intelligence controlled root', 'SI_NODE_RUNTIME_IMAGE=$node_runtime_image']) {
  if (!productionDeploy.includes(marker)) errors.push(`production deploy missing Node runtime gate ${marker}`)
}
const internalDeploy = await fs.readFile(path.join(root, 'scripts/deploy-internal-engineering-shadow.sh'), 'utf8')
for (const marker of ['SI_NODE_RUNTIME_IMAGE is required', 'SI_NODE_RUNTIME_IMAGE=$node_runtime_image']) {
  if (!internalDeploy.includes(marker)) errors.push(`internal deploy missing Node runtime gate ${marker}`)
}
const internalRun = await fs.readFile(path.join(root, 'scripts/run-internal-engineering-once.sh'), 'utf8')
for (const marker of ['capture-internal-engineering-runtime-state.sh', 'capture-shadow-side-effects.sh', 'compile-internal-engineering-run-evidence.mjs', 'validate-internal-engineering-run-evidence.mjs', 'evidence_created=1', 'counts_toward_production_shadow=0']) {
  if (!internalRun.includes(marker)) errors.push(`internal run missing evidence marker ${marker}`)
}
const isolatedMigrationValidation = await fs.readFile(path.join(root, 'scripts/validate-candidate-migrations-isolated.sh'), 'utf8')
for (const marker of ['write-shadow-domain-runtime-fixture.mjs', 'compile-shadow-domain-sql.mjs', 'domain_persistence_idempotent=verified', 'acl_fail_closed=verified']) {
  if (!isolatedMigrationValidation.includes(marker)) errors.push(`isolated migration validation missing ${marker}`)
}
const qnapNodeRuntime = await fs.readFile(path.join(root, 'scripts/node-runtime.sh'), 'utf8')
for (const marker of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges:true', 'immutable QNAP Node runtime image required', 'QNAP Node runtime must use a non-root account']) {
  if (!qnapNodeRuntime.includes(marker)) errors.push(`QNAP Node runtime missing ${marker}`)
}
for (const marker of [
  "manifestVersion: '1.5.0'",
  "goal7Migration012Mode: 'pre_existing_reconciliation_only'",
  'goal7Migration012SqlReplayAllowed: false',
  'runtime-component-versions.json',
  "releaseType: 'P1-SI-F-shadow-candidate-gated'",
  'domain_persistence=verified',
  'domain_persistence_idempotent=verified',
  'acl_fail_closed=verified',
  'goal7_app_role_rw=verified',
  'goal7FoundationEvidenceSha256',
  'reviewerRoleAccessGateRequired: true',
]) {
  if (!runtimeWorkflow.includes(marker)) errors.push(`runtime workflow is stale: ${marker}`)
}
for (const name of ['internal:validate', 'internal:readiness', 'internal:compile-runtime', 'internal:validate-runtime']) {
  if (!packageJson.scripts?.[name]) errors.push(`missing package script ${name}`)
}
for (const key of ['formalP2CountMax', 'employeeDeliveryCountMax', 'erpWritebackCountMax', 'socialWritebackCountMax', 'causalActivationCountMax']) {
  if (policy.acceptanceThresholds[key] !== 0) errors.push(`${key} must remain zero`)
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, serviceCount: Object.keys(compose.services).length, requiredConsecutiveNaturalDays: 7 }, null, 2)}\n`)
}
