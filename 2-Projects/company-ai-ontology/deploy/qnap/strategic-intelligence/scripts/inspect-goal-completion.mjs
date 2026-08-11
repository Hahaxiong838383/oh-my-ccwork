#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gates = []

function addGate(key, passed, reasonCode) {
  gates.push({ key, status: passed ? 'pass' : 'blocked', reasonCode: passed ? 'ok' : reasonCode })
}

function existingFiles(files) {
  return files.length > 0 && files.every((file) => typeof file === 'string' && file.length > 0 && fs.existsSync(file) && fs.statSync(file).isFile())
}

function runValidator(key, validator, files) {
  if (!existingFiles(files)) {
    addGate(key, false, 'missing_input')
    return null
  }
  const result = spawnSync(process.execPath, [validator, ...files], { encoding: 'utf8' })
  addGate(key, result.status === 0, result.status === 0 ? 'ok' : 'validation_failed')
  return result.status === 0 ? JSON.parse(result.stdout) : null
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const releaseRoot = process.env.SI_RELEASE_ROOT
const releaseFiles = releaseRoot ? [
  path.join(releaseRoot, 'release-manifest.json'),
  path.join(releaseRoot, 'source.tar.gz'),
  path.join(releaseRoot, 'collector-image.tar.gz'),
] : []
const releaseValidation = runValidator('immutable_release', path.join(root, 'scripts/validate-release-manifest.mjs'), releaseFiles)

const sourceRegistryValidation = runValidator('approved_source_registry', path.join(root, 'scripts/validate-approved-registry.mjs'), [
  process.env.SI_APPROVED_SOURCE_REGISTRY_FILE,
  process.env.SI_APPROVED_COLLECTOR_CONFIG_FILE,
])
const p003ReviewValidation = runValidator('approved_p003_review', path.join(root, 'scripts/validate-approved-p003-review.mjs'), [
  process.env.SI_APPROVED_P003_REVIEW_FILE,
])
const reviewerRoleValidation = runValidator('reviewer_role_access_acceptance', path.join(root, 'scripts/validate-reviewer-role-access-acceptance.mjs'), [
  process.env.SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE,
])
const goal7Validation = runValidator('goal7_owner_acceptance', path.join(root, 'scripts/validate-goal7-acceptance.mjs'), [
  process.env.SI_GOAL7_ACCEPTANCE_FILE,
])

const completionFile = process.env.SI_GOAL_COMPLETION_EVIDENCE_FILE
const completionValidation = runValidator('deployment_completion_evidence', path.join(root, 'scripts/validate-goal-completion-evidence.mjs'), [completionFile])

const acceptedSummaryFile = process.env.SI_SEVEN_DAY_ACCEPTED_SUMMARY_FILE
const evidenceRoot = process.env.SI_SEVEN_DAY_EVIDENCE_ROOT
let sevenDayValidation = null
const sevenDayInputsExist = existingFiles([acceptedSummaryFile])
  && typeof evidenceRoot === 'string'
  && evidenceRoot.length > 0
  && fs.existsSync(evidenceRoot)
  && fs.statSync(evidenceRoot).isDirectory()
if (!sevenDayInputsExist) {
  addGate('seven_day_owner_acceptance', false, 'missing_input')
} else {
  const validation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-seven-day-shadow-summary.mjs'), acceptedSummaryFile, evidenceRoot], { encoding: 'utf8' })
  addGate('seven_day_owner_acceptance', validation.status === 0, validation.status === 0 ? 'ok' : 'validation_failed')
  if (validation.status === 0) sevenDayValidation = JSON.parse(validation.stdout)
}

let identityConsistent = false
if (releaseValidation && sourceRegistryValidation && p003ReviewValidation && reviewerRoleValidation && goal7Validation && completionValidation && sevenDayValidation) {
  try {
    const [manifestBytes, completionBytes, summaryBytes] = await Promise.all([
      fsp.readFile(releaseFiles[0]),
      fsp.readFile(completionFile),
      fsp.readFile(acceptedSummaryFile),
    ])
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const completion = JSON.parse(completionBytes.toString('utf8'))
    const summary = JSON.parse(summaryBytes.toString('utf8'))
    identityConsistent = Boolean(
      completion.releaseIdentity.sourceCommit === manifest.sourceCommit
      && completion.releaseIdentity.collectorImage === manifest.collectorImageId
      && completion.releaseIdentity.candidateOntologySchema === manifest.candidateOntologySchema
      && completion.releaseIdentity.candidateOntologyHash === manifest.candidateOntologyHash
      && completion.releaseIdentity.releaseManifestHash === sha256(manifestBytes)
      && summary.runtimeIdentity.sourceCommit === manifest.sourceCommit
      && summary.runtimeIdentity.collectorImage === manifest.collectorImageId
      && completion.policyIdentity.policyVersion === summary.runtimeIdentity.policyVersion
      && completion.policyIdentity.policyHash === summary.runtimeIdentity.policyHash
      && completion.approvalEvidenceHashes.sourceRegistry === sourceRegistryValidation.registryHash
      && completion.approvalEvidenceHashes.p003Review === p003ReviewValidation.workbookHash
      && completion.approvalEvidenceHashes.reviewerRoleAccess === reviewerRoleValidation.evidenceHash
      && completion.approvalEvidenceHashes.goal7 === goal7Validation.evidenceHash
      && completion.sevenDay.summaryHash === sha256(summaryBytes)
      && completion.sevenDay.ownerAcceptanceRef === summary.ownerAcceptance.acceptanceRef
      && Date.parse(completion.verifiedAt) >= Date.parse(summary.ownerAcceptance.acceptedAt)
    )
  } catch {
    identityConsistent = false
  }
}
addGate('release_deployment_shadow_identity', identityConsistent, 'identity_mismatch')

const blocked = gates.filter((gate) => gate.status === 'blocked')
const result = {
  ok: blocked.length === 0,
  goalCompletionEligible: blocked.length === 0,
  requiredGate: blocked.length === 0 ? 'GOAL_COMPLETE' : 'WAIT_PRODUCTION_SHADOW_AND_OWNER_ACCEPTANCE',
  passedGateCount: gates.length - blocked.length,
  blockedGateCount: blocked.length,
  productionShadowCompleted: blocked.length === 0,
  businessSideEffectsZero: blocked.length === 0,
  gates,
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (blocked.length > 0) process.exitCode = 2
