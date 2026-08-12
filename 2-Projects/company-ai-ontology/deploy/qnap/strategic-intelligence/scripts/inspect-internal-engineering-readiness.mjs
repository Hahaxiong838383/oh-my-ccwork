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

const planFile = process.env.SI_INTERNAL_ENGINEERING_PLAN_FILE || path.join(root, 'config/internal-engineering-shadow-plan.json')
const planValidation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-internal-engineering-shadow-plan.mjs'), planFile], { encoding: 'utf8' })
addGate('internal_engineering_plan', planValidation.status === 0, 'internal_plan_invalid')
addGate('internal_deployment_authorization', process.env.INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED === 'YES', 'explicit_internal_deployment_authorization_missing')
addGate('company_qnap_preflight', process.env.COMPANY_QNAP_PREFLIGHT_VERIFIED === 'YES', 'company_qnap_preflight_missing')

const releaseRoot = process.env.SI_RELEASE_ROOT
const releaseFiles = releaseRoot ? [
  path.join(releaseRoot, 'release-manifest.json'),
  path.join(releaseRoot, 'source.tar.gz'),
  path.join(releaseRoot, 'h-lite-source.tar.gz'),
  path.join(releaseRoot, 'collector-image.tar.gz'),
  path.join(releaseRoot, 'runtime-component-versions.json'),
] : []
const releaseFilesExist = releaseFiles.length === 5 && releaseFiles.every((file) => fs.existsSync(file) && fs.statSync(file).isFile())
if (!releaseFilesExist) {
  addGate('immutable_release', false, 'missing_input')
} else {
  const releaseValidation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-release-manifest.mjs'), ...releaseFiles], { encoding: 'utf8' })
  addGate('immutable_release', releaseValidation.status === 0, 'validation_failed')
}

const blocked = gates.filter((gate) => gate.status === 'blocked')
const result = {
  ok: blocked.length === 0,
  internalDeploymentEligible: blocked.length === 0,
  productionDeploymentEligible: false,
  requiredGate: blocked.length === 0 ? 'READY_FOR_EXPLICIT_INTERNAL_DEPLOYMENT' : 'WAIT_INTERNAL_DEPLOY_AUTH_AND_RELEASE',
  passedGateCount: gates.length - blocked.length,
  blockedGateCount: blocked.length,
  deferredBeforeProduction: [
    'source_final_approval',
    'p003_final_review',
    'reviewer_role_uat',
    'goal7_owner_acceptance',
    'production_seven_day_shadow',
  ],
  gates,
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (blocked.length > 0) process.exitCode = 2
