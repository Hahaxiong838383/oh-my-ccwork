#!/usr/bin/env node

import path from 'node:path'

import { writeReviewerRoleAccessAcceptance } from './reviewer-role-access-lib.mjs'

const bundleRoot = process.env.SI_REVIEWER_ROLE_ACCESS_BUNDLE_ROOT || process.argv[2]
const outputFile = process.env.SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE || process.argv[3]
if (!bundleRoot) throw new Error('reviewer role access bundle root is required')
const acceptance = await writeReviewerRoleAccessAcceptance(path.resolve(bundleRoot), outputFile ? path.resolve(outputFile) : undefined)
process.stdout.write(`${JSON.stringify({ ok: true, scopedRoleCount: acceptance.roleTests.length, acceptedAt: acceptance.acceptedAt, rawEvidenceFileCount: Object.keys(acceptance.rawEvidenceFiles).length }, null, 2)}\n`)
