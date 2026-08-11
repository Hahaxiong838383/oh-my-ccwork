import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  compileShadowSourceRegistry,
  createP003ReviewWorkbook,
  createSourceApprovalWorkbook,
  loadP003ReviewContext,
  loadSourceApprovalContext,
} from '../../../../../packages/ontology-contracts/src/index.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function principal(role) {
  return {
    role,
    displayName: `${role}-reviewer`,
    principalRef: `company-directory:${role}-reviewer`,
    decision: 'approve',
  }
}

export function reviewerRoleAcceptance() {
  const roleTests = [
    ['product_user', ['product_definition', 'children_user_scenario', 'channel_sales_competition', 'ai_technology', 'privacy_safety_compliance'], 30, 6],
    ['ai_rd', ['product_definition', 'children_user_scenario', 'ai_technology'], 18, 18],
    ['brand', ['channel_sales_competition'], 6, 30],
    ['toc_offline_channel', ['channel_sales_competition'], 6, 30],
  ].map(([roleKey, expectedEditableCategories, expectedEditableRecordCount, expectedDeniedRecordCount]) => ({
    roleKey,
    expectedEditableCategories,
    expectedEditableRecordCount,
    expectedDeniedRecordCount,
    memberPrincipal: principal(roleKey),
    testedAt: '2026-08-11T00:00:00Z',
    evidenceRefs: [`feishu:base/p1-si-role-access/${roleKey}`],
    authenticatedAsAssignedMember: true,
    assignedCategoryEditSucceeded: true,
    unassignedCategoryEditDenied: true,
    sourceTableAccessDenied: true,
    recordCreateDenied: true,
    recordDeleteDenied: true,
    copyDenied: true,
    downloadDenied: true,
    viewMutationDenied: true,
    temporaryEditReverted: true,
  }))
  return {
    evidenceVersion: '1.0.0',
    workbenchKey: 'P1-SI-HUMAN-REVIEW',
    status: 'complete',
    memberExperienceVerified: true,
    securityOwnerAccepted: true,
    acceptedAt: '2026-08-11T00:00:00Z',
    securityOwner: principal('security_owner'),
    ownerAcceptanceRef: 'feishu:doc/p1-si-role-access-owner-acceptance',
    evidenceRefs: ['feishu:doc/p1-si-role-access-evidence'],
    categoryFieldType: 'SingleSelect',
    allFiltersValid: true,
    legacyBroadRoleMemberCount: 0,
    publicOutputContainsSensitiveData: false,
    roleTests,
  }
}

export async function createReadyInputs() {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-readiness-'))
  const releaseRoot = path.join(outputRoot, 'release')
  await fs.mkdir(releaseRoot)
  const sourceBytes = Buffer.from('source archive')
  const imageBytes = Buffer.from('collector image archive')
  await fs.writeFile(path.join(releaseRoot, 'source.tar.gz'), sourceBytes)
  await fs.writeFile(path.join(releaseRoot, 'collector-image.tar.gz'), imageBytes)
  await fs.writeFile(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({
    manifestVersion: '1.2.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    createdAt: '2026-08-11T00:00:00Z',
    sourceCommit: 'a'.repeat(40),
    collectorImageId: `sha256:${'b'.repeat(64)}`,
    sourceArchiveSha256: sha256(sourceBytes),
    collectorImageArchiveSha256: sha256(imageBytes),
    candidateOntologySchema: '3.7.0',
    candidateOntologyHash: 'c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860',
    sourceRegistryCandidateHash: '0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae',
    publish: false,
    productionDeploymentAuthorized: false,
    requiredGate: 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
    p003ReviewGateRequired: true,
    reviewerRoleAccessGateRequired: true,
    goal7AcceptanceGateRequired: true,
  }))

  const { sourceContract, catalog, approvalContract } = await loadSourceApprovalContext()
  const sourceWorkbook = createSourceApprovalWorkbook(catalog)
  for (const review of sourceWorkbook.reviews) {
    review.decision = 'keep_paused'
    review.approvedAt = '2026-08-11T00:00:00Z'
    review.decisionReason = '来源继续暂停。'
    review.namedComplianceDri = principal('compliance')
  }
  const approvedSource = sourceWorkbook.reviews[0]
  approvedSource.decision = 'approve_for_shadow'
  approvedSource.licenseDecision = 'approved'
  approvedSource.complianceDecision = 'approved'
  approvedSource.approvedStorageLevel = approvedSource.candidateStorageLevel
  approvedSource.approvedRetentionDays = approvedSource.candidateRetentionDays
  approvedSource.licenseEvidenceRefs = [approvedSource.candidateLicenseEvidenceRef]
  approvedSource.complianceEvidenceRefs = ['feishu:doc/company-source-approval']
  approvedSource.namedLicenseReviewer = principal('license')
  approvedSource.decisionReason = '批准仅用于 PUBLISH=false Shadow。'
  const compiled = compileShadowSourceRegistry(sourceWorkbook, catalog, sourceContract, approvalContract)
  const registryFile = path.join(outputRoot, 'approved-source-registry.json')
  const collectorConfigFile = path.join(outputRoot, 'approved-collector-config.json')
  await fs.writeFile(registryFile, JSON.stringify(compiled.registry))
  await fs.writeFile(collectorConfigFile, JSON.stringify({ sourceKeys: [approvedSource.sourceKey] }))

  const { catalog: p003Catalog } = await loadP003ReviewContext()
  const p003Workbook = createP003ReviewWorkbook(p003Catalog)
  for (const review of p003Workbook.reviews) {
    review.decision = 'keep_inactive'
    review.reviewedAt = '2026-08-11T00:00:00Z'
    review.decisionReason = '真实 DRI 已完成审核，本条关系继续保持 inactive。'
    review.reviewParticipants = [principal(review.proposedDriRoles[0] || 'product')]
  }
  const p003ReviewFile = path.join(outputRoot, 'approved-p003-review.json')
  await fs.writeFile(p003ReviewFile, JSON.stringify(p003Workbook))

  const reviewerRoleAccessFile = path.join(outputRoot, 'reviewer-role-access-acceptance.json')
  await fs.writeFile(reviewerRoleAccessFile, JSON.stringify(reviewerRoleAcceptance()))

  const goal7File = path.join(outputRoot, 'goal7-acceptance.json')
  await fs.writeFile(goal7File, JSON.stringify({
    evidenceVersion: '1.0.0',
    goalKey: 'P1-PROD-READINESS',
    status: 'complete',
    engineeringVerified: true,
    ownerAccepted: true,
    acceptedAt: '2026-08-11T00:00:00Z',
    sourceCommit: 'c'.repeat(40),
    ownerAcceptanceRef: 'feishu:doc/goal7-owner-acceptance',
    evidenceRefs: ['git:commit/goal7-accepted', 'qnap:acceptance/goal7'],
    authorityEvidence: {
      principalModelVerified: true,
      senderPrincipalIsolationVerified: true,
      purposeNarrowingVerified: true,
      revocationFailClosedVerified: true,
      readBeforeBodyAclVerified: true,
    },
    runtimeEvidence: {
      circuitBreakerVerified: true,
      retryBudgetVerified: true,
      costBudgetVerified: true,
      realModelReadbackVerified: true,
    },
    routeState: { routeAOperational: true, routeBEnabled: false },
    closedCapabilities: {
      productResearchBulkImport: false,
      realEmployeeCanary: false,
      employeePrivateBotMigration: false,
      erpWriteback: false,
      socialWriteback: false,
    },
  }))

  return { outputRoot, releaseRoot, registryFile, collectorConfigFile, p003ReviewFile, reviewerRoleAccessFile, goal7File }
}
