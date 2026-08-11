#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gates = []

function addGate(key, passed, reasonCode) {
  gates.push({
    key,
    status: passed ? 'pass' : 'blocked',
    reasonCode: passed ? 'ok' : reasonCode,
  })
}

function existingFiles(files) {
  return files.length > 0 && files.every((file) => typeof file === 'string' && file.length > 0 && fs.existsSync(file) && fs.statSync(file).isFile())
}

function validateFiles(key, validator, files) {
  if (!existingFiles(files)) {
    addGate(key, false, 'missing_input')
    return
  }
  const result = spawnSync(process.execPath, [validator, ...files], { encoding: 'utf8' })
  addGate(key, result.status === 0, result.status === 0 ? 'ok' : 'validation_failed')
}

addGate('deployment_authorization', process.env.SHADOW_DEPLOY_APPROVED === 'YES', 'explicit_authorization_missing')
addGate('goal7_status', process.env.GOAL7_STATUS === 'complete', 'goal7_not_complete')

const releaseRoot = process.env.SI_RELEASE_ROOT
const releaseFiles = releaseRoot ? [
  path.join(releaseRoot, 'release-manifest.json'),
  path.join(releaseRoot, 'source.tar.gz'),
  path.join(releaseRoot, 'collector-image.tar.gz'),
] : []
validateFiles('immutable_release', path.join(root, 'scripts/validate-release-manifest.mjs'), releaseFiles)

validateFiles('approved_source_registry', path.join(root, 'scripts/validate-approved-registry.mjs'), [
  process.env.SI_APPROVED_SOURCE_REGISTRY_FILE,
  process.env.SI_APPROVED_COLLECTOR_CONFIG_FILE,
])

validateFiles('approved_p003_review', path.join(root, 'scripts/validate-approved-p003-review.mjs'), [
  process.env.SI_APPROVED_P003_REVIEW_FILE,
])

validateFiles('reviewer_role_access_acceptance', path.join(root, 'scripts/validate-reviewer-role-access-acceptance.mjs'), [
  process.env.SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE,
])

validateFiles('goal7_owner_acceptance', path.join(root, 'scripts/validate-goal7-acceptance.mjs'), [
  process.env.SI_GOAL7_ACCEPTANCE_FILE,
])

const blocked = gates.filter((gate) => gate.status === 'blocked')
const result = {
  ok: blocked.length === 0,
  deploymentEligible: blocked.length === 0,
  requiredGate: blocked.length === 0 ? 'READY_FOR_EXPLICIT_DEPLOYMENT' : 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
  passedGateCount: gates.length - blocked.length,
  blockedGateCount: blocked.length,
  gates,
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (blocked.length > 0) process.exitCode = 2
