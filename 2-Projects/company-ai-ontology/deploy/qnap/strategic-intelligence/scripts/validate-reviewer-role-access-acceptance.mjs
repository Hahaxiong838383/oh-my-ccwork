#!/usr/bin/env node

import { validateReviewerRoleAccessAcceptance } from './reviewer-role-access-lib.mjs'

const acceptanceFile = process.argv[2]
if (!acceptanceFile) throw new Error('reviewer role access acceptance file is required')

const { acceptance, evidenceHash } = await validateReviewerRoleAccessAcceptance(acceptanceFile)
process.stdout.write(`${JSON.stringify({
  ok: true,
  workbenchKey: acceptance.workbenchKey,
  acceptedAt: acceptance.acceptedAt,
  scopedRoleCount: acceptance.roleTests.length,
  memberExperienceVerified: true,
  legacyBroadRoleMemberCount: 0,
  rawEvidenceFileCount: Object.keys(acceptance.rawEvidenceFiles).length,
  evidenceHash,
}, null, 2)}\n`)
