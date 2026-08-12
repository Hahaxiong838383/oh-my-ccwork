#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadAndValidateGoal7ReleasePlan } from './goal7-release-plan-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const planFile = process.env.GOAL7_RELEASE_PLAN_FILE || process.argv[2] || path.join(root, 'config/goal7-foundation-release-plan.json')
const result = await loadAndValidateGoal7ReleasePlan(planFile, {
  prepare: await fs.readFile(path.join(root, 'scripts/prepare-goal7-foundation.sh'), 'utf8'),
  migrate: await fs.readFile(path.join(root, 'scripts/apply-goal7-migration-012.sh'), 'utf8'),
  verifyMigration: await fs.readFile(path.join(root, 'scripts/verify-goal7-migration-012-live.sh'), 'utf8'),
  deploy: await fs.readFile(path.join(root, 'scripts/deploy-goal7-foundation.sh'), 'utf8'),
  rollback: await fs.readFile(path.join(root, 'scripts/rollback-goal7-foundation.sh'), 'utf8'),
})
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
