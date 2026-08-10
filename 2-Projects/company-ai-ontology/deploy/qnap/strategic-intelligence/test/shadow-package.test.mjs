import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { tick } from '../orchestrator/orchestrator.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(ROOT, '../../..')

async function json(relative) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relative), 'utf8'))
}

test('shadow compose isolates services, ports, socket, privileges and side effects', async () => {
  const compose = await json('docker-compose.shadow.yml')
  assert.deepEqual(Object.keys(compose.services).sort(), ['intelligence-collector', 'intelligence-orchestrator'])
  for (const service of Object.values(compose.services)) {
    assert.equal(service.ports, undefined)
    assert.equal(service.expose, undefined)
    assert.notEqual(service.privileged, true)
    assert.equal(service.read_only, true)
    assert.ok(service.cap_drop.includes('ALL'))
    assert.ok(service.security_opt.includes('no-new-privileges:true'))
    assert.ok(service.volumes.every((entry) => !entry.includes('docker.sock')))
    assert.equal(service.environment.PUBLISH, 'false')
    assert.equal(service.environment.FORMAL_P2_ENABLED, 'false')
    assert.equal(service.environment.EMPLOYEE_DELIVERY_ENABLED, 'false')
    assert.equal(service.environment.ERP_WRITEBACK_ENABLED, 'false')
    assert.equal(service.environment.SOCIAL_WRITEBACK_ENABLED, 'false')
    assert.equal(service.environment.CAUSAL_ACTIVATION_ENABLED, 'false')
  }
})

test('collector remains a resource-limited ephemeral worker', async () => {
  const compose = await json('docker-compose.shadow.yml')
  const collector = compose.services['intelligence-collector']
  assert.equal(collector.cpus, 0.5)
  assert.equal(collector.mem_limit, '512m')
  assert.equal(collector.restart, 'no')
  assert.deepEqual(collector.profiles, ['worker'])
  assert.match(collector.image, /sha256/)
  assert.ok(!collector.command.join(' ').includes('publish'))
})

test('orchestrator emits one idempotent publish=false request per Shanghai natural day', async () => {
  const policy = await json('config/shadow-policy.json')
  const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-orchestrator-'))
  const now = new Date('2026-08-10T22:30:00Z')
  const first = await tick({ policy, queueRoot, now })
  const second = await tick({ policy, queueRoot, now })
  assert.equal(first.length, 1)
  assert.equal(second.length, 0)
  assert.equal(first[0].localDate, '2026-08-11')
  assert.equal(first[0].publish, false)
  assert.deepEqual(first[0].forbiddenSideEffects, ['formal_p2', 'employee_delivery', 'erp_writeback', 'social_writeback', 'causal_activation'])
})

test('threshold policy freezes all business side effects at zero', async () => {
  const policy = await json('config/shadow-policy.json')
  assert.equal(policy.requiredConsecutiveNaturalDays, 7)
  assert.equal(policy.resourceLimits.collectorCpuCores, 0.5)
  assert.equal(policy.resourceLimits.collectorMemoryMiB, 512)
  for (const key of ['formalP2CountMax', 'employeeDeliveryCountMax', 'erpWritebackCountMax', 'socialWritebackCountMax', 'causalActivationCountMax']) {
    assert.equal(policy.acceptanceThresholds[key], 0)
  }
  assert.equal(policy.automaticResponse.defaultAction, 'freeze_shadow')
  assert.equal(policy.automaticResponse.rollbackRequiresPreapprovalEnvironment, 'SHADOW_AUTO_ROLLBACK_APPROVED=YES')
})

test('deployment scripts only target strategic intelligence services and keep explicit gates', async () => {
  const names = ['dispatch-next.sh', 'freeze-shadow.sh', 'backup-shadow.sh', 'rollback-shadow.sh', 'prepare-shadow-release.sh', 'apply-shadow-migrations.sh', 'deploy-shadow.sh', 'install-dispatcher-cron.sh']
  const forbiddenServiceCommands = /compose\s+(?:--[^\s]+\s+)*(?:up|restart|stop)\b[^\n]*(?:agent-core|h-lite|domain-connector|knowledge-connector|gateway|postgres|redis|qdrant)/
  for (const name of names) {
    const script = await fs.readFile(path.join(ROOT, 'scripts', name), 'utf8')
    assert.doesNotMatch(script, /git add \.|git add -A/)
    assert.doesNotMatch(script, /docker\.sock/)
    assert.doesNotMatch(script, forbiddenServiceCommands)
  }
  const rollback = await fs.readFile(path.join(ROOT, 'scripts/rollback-shadow.sh'), 'utf8')
  assert.match(rollback, /SHADOW_ROLLBACK_APPROVED/)
  const prepare = await fs.readFile(path.join(ROOT, 'scripts/prepare-shadow-release.sh'), 'utf8')
  assert.match(prepare, /HEAD must equal the pushed upstream commit/)
  assert.match(prepare, /release requires a clean project subtree/)
  assert.match(prepare, /source_commit}:2-Projects\/company-ai-ontology/)
  const deploy = await fs.readFile(path.join(ROOT, 'scripts/deploy-shadow.sh'), 'utf8')
  assert.match(deploy, /SHADOW_DEPLOY_APPROVED/)
  assert.match(deploy, /GOAL7_STATUS/)
  assert.match(deploy, /up -d --no-deps intelligence-orchestrator/)
  assert.doesNotMatch(deploy, /up -d[^\n]*(?:agent-core|h-lite|connector|gateway|postgres|redis|qdrant)/)
})

test('candidate migrations remain outside production migrations and isolated validation restores baseline', async () => {
  const productionMigrations = await fs.readdir(path.join(PROJECT_ROOT, 'deploy/qnap/migrations'))
  assert.ok(!productionMigrations.some((name) => /^01[01]-pestim/.test(name)))
  for (const name of ['010-pestim-strategic-intelligence.sql', '011-pestim-reporting.sql']) {
    await fs.access(path.join(PROJECT_ROOT, 'deploy/qnap/candidate-migrations', name))
  }
  const validator = await fs.readFile(path.join(ROOT, 'scripts/validate-candidate-migrations-isolated.sh'), 'utf8')
  assert.match(validator, /--network none/)
  assert.match(validator, /VALIDATION_POSTGRES_IMAGE/)
  assert.match(validator, /baseline\.dump/)
  assert.match(validator, /ontology_restore/)
})

test('seven-day pack generator creates exactly seven pending real-run evidence files', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-seven-day-'))
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/generate-seven-day-pack.mjs'), outputRoot, '2026-08-11'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const files = (await fs.readdir(outputRoot)).sort()
  assert.equal(files.length, 7)
  const first = JSON.parse(await fs.readFile(path.join(outputRoot, files[0]), 'utf8'))
  const last = JSON.parse(await fs.readFile(path.join(outputRoot, files[6]), 'utf8'))
  assert.equal(first.status, 'pending_real_run')
  assert.equal(first.simulated, false)
  assert.equal(last.dayNumber, 7)
})

test('runtime metrics parser records CPU, memory and network without exposing payloads', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-stats-'))
  const statsFile = path.join(outputRoot, 'stats.jsonl')
  await fs.writeFile(statsFile, [
    JSON.stringify({ cpu: '12.50%', mem: '128MiB / 512MiB', net: '1.5MB / 500kB' }),
    JSON.stringify({ cpu: '48.25%', mem: '300MiB / 512MiB', net: '3MB / 1MB' }),
  ].join('\n'))
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/summarize-docker-stats.mjs'), statsFile], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const metrics = JSON.parse(result.stdout)
  assert.equal(metrics.collected, true)
  assert.equal(metrics.peakCpuPermille, 483)
  assert.equal(metrics.peakMemoryBytes, 300 * 1024 * 1024)
  assert.equal(metrics.networkBytes, 4_000_000)
})
