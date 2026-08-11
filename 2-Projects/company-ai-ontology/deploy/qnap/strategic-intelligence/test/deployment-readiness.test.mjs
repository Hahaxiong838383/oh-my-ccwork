import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createReadyInputs,
  reviewerRoleAcceptance,
} from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSPECTOR = path.join(ROOT, 'scripts/inspect-deployment-readiness.mjs')

test('readiness inspector reports every missing gate without exposing paths', () => {
  const result = spawnSync(process.execPath, [INSPECTOR], { encoding: 'utf8', env: {} })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.equal(output.deploymentEligible, false)
  assert.equal(output.blockedGateCount, 7)
  assert.equal(output.requiredGate, 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH')
  assert.ok(output.gates.every((gate) => gate.status === 'blocked'))
  assert.deepEqual(output.gates.find((gate) => gate.key === 'immutable_release'), {
    key: 'immutable_release',
    status: 'blocked',
    reasonCode: 'missing_input',
  })
  assert.doesNotMatch(result.stdout, /\/Users\//)
  assert.doesNotMatch(result.stdout, /\/share\//)
})

test('readiness inspector accepts only fully validated deployment inputs', async () => {
  const inputs = await createReadyInputs()
  const result = spawnSync(process.execPath, [INSPECTOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHADOW_DEPLOY_APPROVED: 'YES',
      GOAL7_STATUS: 'complete',
      SI_RELEASE_ROOT: inputs.releaseRoot,
      SI_APPROVED_SOURCE_REGISTRY_FILE: inputs.registryFile,
      SI_APPROVED_COLLECTOR_CONFIG_FILE: inputs.collectorConfigFile,
      SI_APPROVED_P003_REVIEW_FILE: inputs.p003ReviewFile,
      SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE: inputs.reviewerRoleAccessFile,
      SI_GOAL7_ACCEPTANCE_FILE: inputs.goal7File,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.deploymentEligible, true)
  assert.equal(output.passedGateCount, 7)
  assert.equal(output.blockedGateCount, 0)
  assert.equal(output.requiredGate, 'READY_FOR_EXPLICIT_DEPLOYMENT')
})

test('readiness inspector fails closed when a present approval file is invalid', async () => {
  const inputs = await createReadyInputs()
  await fs.writeFile(inputs.goal7File, JSON.stringify({ status: 'pending' }))
  const result = spawnSync(process.execPath, [INSPECTOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHADOW_DEPLOY_APPROVED: 'YES',
      GOAL7_STATUS: 'complete',
      SI_RELEASE_ROOT: inputs.releaseRoot,
      SI_APPROVED_SOURCE_REGISTRY_FILE: inputs.registryFile,
      SI_APPROVED_COLLECTOR_CONFIG_FILE: inputs.collectorConfigFile,
      SI_APPROVED_P003_REVIEW_FILE: inputs.p003ReviewFile,
      SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE: inputs.reviewerRoleAccessFile,
      SI_GOAL7_ACCEPTANCE_FILE: inputs.goal7File,
    },
  })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  const goal7Gate = output.gates.find((gate) => gate.key === 'goal7_owner_acceptance')
  assert.deepEqual(goal7Gate, { key: 'goal7_owner_acceptance', status: 'blocked', reasonCode: 'validation_failed' })
  assert.doesNotMatch(result.stdout, /ownerAccepted/)
})

test('readiness inspector blocks API-only role configuration without member experience acceptance', async () => {
  const inputs = await createReadyInputs()
  await fs.writeFile(inputs.reviewerRoleAccessFile, JSON.stringify({
    ...reviewerRoleAcceptance(),
    memberExperienceVerified: false,
  }))
  const result = spawnSync(process.execPath, [INSPECTOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHADOW_DEPLOY_APPROVED: 'YES',
      GOAL7_STATUS: 'complete',
      SI_RELEASE_ROOT: inputs.releaseRoot,
      SI_APPROVED_SOURCE_REGISTRY_FILE: inputs.registryFile,
      SI_APPROVED_COLLECTOR_CONFIG_FILE: inputs.collectorConfigFile,
      SI_APPROVED_P003_REVIEW_FILE: inputs.p003ReviewFile,
      SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE: inputs.reviewerRoleAccessFile,
      SI_GOAL7_ACCEPTANCE_FILE: inputs.goal7File,
    },
  })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.gates.find((gate) => gate.key === 'reviewer_role_access_acceptance'), {
    key: 'reviewer_role_access_acceptance',
    status: 'blocked',
    reasonCode: 'validation_failed',
  })
  assert.doesNotMatch(result.stdout, /memberExperienceVerified/)
})
