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
import { writeGoal7AcceptanceEvidence, writeGoal7OwnerAcceptanceEvidence } from '../../scripts/goal7-evidence-lib.mjs'
import { writeGoal7DeploymentEvidence } from '../../scripts/goal7-deployment-lib.mjs'
import { writeGoal7WorkerReadbackEvidence } from '../../scripts/goal7-worker-readback-lib.mjs'
import { writeReviewerRoleAccessAcceptance } from '../../scripts/reviewer-role-access-lib.mjs'

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

export async function createReviewerRoleAccessBundle(outputRoot) {
  const roles = [
    ['product_user', ['product_definition', 'children_user_scenario', 'channel_sales_competition', 'ai_technology', 'privacy_safety_compliance'], 30, 6],
    ['ai_rd', ['product_definition', 'children_user_scenario', 'ai_technology'], 18, 18],
    ['brand', ['channel_sales_competition'], 6, 30],
    ['toc_offline_channel', ['channel_sales_competition'], 6, 30],
  ]
  const hashes = {}
  for (const [index, [roleKey, expectedEditableCategories, expectedEditableRecordCount, expectedDeniedRecordCount]] of roles.entries()) {
    const value = {
      evidenceVersion: '1.0.0',
      evidenceType: 'reviewer-role-member-session',
      workbenchKey: 'P1-SI-HUMAN-REVIEW',
      roleKey,
      testedAt: `2026-08-11T09:${String(index * 5).padStart(2, '0')}:00Z`,
      memberPrincipal: principal(roleKey),
      evidenceRef: `feishu:base/p1-si-role-access/${roleKey}`,
      expectedEditableCategories,
      expectedEditableRecordCount,
      expectedDeniedRecordCount,
      results: {
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
      },
      publicOutputContainsSensitiveData: false,
    }
    const bytes = Buffer.from(JSON.stringify(value))
    const file = path.join(outputRoot, `reviewer-role-session-${roleKey.replaceAll('_', '-')}.json`)
    await fs.writeFile(file, bytes)
    hashes[roleKey] = sha256(bytes)
  }
  await fs.writeFile(path.join(outputRoot, 'reviewer-role-security-owner-acceptance.json'), JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'reviewer-role-security-owner-acceptance',
    workbenchKey: 'P1-SI-HUMAN-REVIEW',
    accepted: true,
    acceptedAt: '2026-08-11T10:00:00Z',
    securityOwner: principal('security_owner'),
    acceptanceRef: 'feishu:doc/p1-si-role-access-owner-acceptance',
    roleSessionHashes: hashes,
    publicOutputContainsSensitiveData: false,
  }))
  const acceptanceFile = path.join(outputRoot, 'reviewer-role-access-acceptance.json')
  const acceptance = await writeReviewerRoleAccessAcceptance(outputRoot, acceptanceFile)
  return { acceptanceFile, acceptance }
}

export async function createGoal7AcceptanceBundle(outputRoot, sourceCommit = 'c'.repeat(40)) {
  const bundleRoot = path.join(outputRoot, 'goal7')
  const hLiteSourceCommit = 'f'.repeat(40)
  await fs.mkdir(bundleRoot, { recursive: true })
  await fs.writeFile(path.join(bundleRoot, 'runtime-verification.json'), JSON.stringify({
    evidenceVersion: '1.0.0',
    verificationType: 'P1-SI-F-linux-amd64-runtime',
    sourceCommit,
    hLiteSourceCommit,
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
    hLiteSourceArchiveSha256: '9'.repeat(64),
    workflowRunId: '31510000000',
    sqlRuntimeVerified: true,
    goal7AuthorityRuntimeFoundation: 'verified',
    goal7FoundationEvidenceSha256: 'a'.repeat(64),
    postgresEvidenceSha256: 'b'.repeat(64),
    routeBState: 'disabled',
    immutableReleaseCandidateVerified: true,
    companyQnapDeployed: false,
    publish: false,
  }))
  await fs.writeFile(path.join(bundleRoot, 'worker-http-response.json'), JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-h-worker-http-response',
    sourceCommit,
    hLiteSourceCommit,
    capturedAt: '2026-08-11T09:00:00Z',
    httpStatus: 200,
    responseStatus: 'completed',
    requestIdHash: 'd'.repeat(64),
    provider: 'cpa-openai-compatible',
    model: 'grok-4.5',
    credentialModeTag: 'temporary_personal_credential',
    productionReady: true,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, estimatedCostMicros: 0 },
    governance: { routeKey: 'route-a', retryCount: 0, ledgerRecorded: true, routeBEnabled: false },
    sensitivePayloadPersisted: false,
  }))
  await fs.writeFile(path.join(bundleRoot, 'worker-ledger-row.json'), JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-h-worker-ledger-row',
    sourceCommit,
    hLiteSourceCommit,
    capturedAt: '2026-08-11T09:00:30Z',
    rowCount: 1,
    requestIdHash: 'd'.repeat(64),
    routeKey: 'route-a',
    provider: 'cpa-openai-compatible',
    model: 'grok-4.5',
    credentialModeTag: 'temporary_personal_credential',
    retryCount: 0,
    outcome: 'succeeded',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, estimatedCostMicros: 0 },
    sensitivePayloadPersisted: false,
  }))
  await writeGoal7WorkerReadbackEvidence(bundleRoot)
  await fs.writeFile(path.join(bundleRoot, 'authority-canary.json'), JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-feishu-authority-canary',
    sourceCommit,
    hLiteSourceCommit,
    capturedAt: '2026-08-11T09:10:00Z',
    evidenceRef: 'qnap:acceptance/goal7-authority-canary',
    runIdHash: 'e'.repeat(64),
    syntheticResourcesOnly: true,
    scenarios: {
      privateSenderOnly: true,
      activeChatMembershipAllowed: true,
      staleChatMembershipFailClosed: true,
      revokedChatMembershipFailClosed: true,
      multiMentionNoExpansion: true,
      purposeNarrowing: true,
      aclFailureBeforeBody: true,
      revocationConvergenceSeconds: 30,
    },
    counts: { scenarioCount: 7, passedCount: 7, bodyReadOnDeniedCount: 0, unauthorizedEvidenceCount: 0 },
    publicOutputContainsSensitiveData: false,
  }))
  const deploymentState = ({ phase, capturedAt, migrationApplied, candidate }) => ({
    snapshotVersion: '1.0.0',
    evidenceType: 'goal7-deployment-state',
    phase,
    capturedAt,
    companyQnapIdentity: 'qnap:company/prnas/TS-X65',
    activeOntologySchema: '3.3.0',
    registryStatus: 'in_sync',
    candidateMigration012Applied: migrationApplied,
    components: {
      agentCore: { version: candidate ? '2026-08-12.3' : '2026-08-08.4', sourceCommit: candidate ? sourceCommit : null, ready: true, productionReady: true },
      knowledgeConnector: { version: candidate ? '2026-08-11.1' : '2026-08-08.3', sourceCommit: candidate ? sourceCommit : null, ready: true, productionReady: true },
      hLite: { version: candidate ? '2026-08-12.1' : '2026-08-08.2', sourceCommit: candidate ? hLiteSourceCommit : null, ready: true, mode: 'active', subscriptionEnabled: true },
    },
    foundation: { criticalContainerCount: 13, unhealthyContainerCount: 0, restartCountTotal: 0, publishedPortCount: 1, fingerprint: (candidate ? '7' : '6').repeat(64) },
    routeState: { routeAOperational: true, routeBEnabled: false },
  })
  await fs.writeFile(path.join(bundleRoot, 'runtime-component-versions.json'), JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-runtime-component-versions',
    sourceCommit,
    hLiteSourceCommit,
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
  }))
  const preparation = {
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-foundation-preparation',
    companyQnapIdentity: 'qnap:company/prnas/TS-X65',
    runId: 'goal7-fixture',
    preparedAt: '2026-08-11T09:12:00Z',
    sourceCommit,
    hLiteSourceCommit,
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
    runtimeRoot: `/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/foundation-releases/${sourceCommit}-${hLiteSourceCommit}`,
    runtimeEvidenceRoot: '/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/goal7-fixture',
    backupRoot: '/share/CACHEDEV2_DATA/ai-ontology-backup/goal7/goal7-fixture',
    runtimeReleaseSha256: '1'.repeat(64),
    runtimeComponentVersionsSha256: '2'.repeat(64),
    runtimeTreeSha256: '3'.repeat(64),
    baselineState: { file: 'preparation-baseline-state.json', sha256: '4'.repeat(64) },
    backup: { envSha256: '5'.repeat(64), composeSha256: '6'.repeat(64) },
    images: {
      agentCore: { previousTag: 'company-ai-foundation-agent-core:goal7-pre-goal7-fixture', previousImageId: `sha256:${'7'.repeat(64)}`, candidateTag: 'company-ai-foundation-agent-core:goal7-candidate-goal7-fixture', candidateImageId: `sha256:${'8'.repeat(64)}` },
      knowledgeConnector: { previousTag: 'company-ai-foundation-knowledge-connector:goal7-pre-goal7-fixture', previousImageId: `sha256:${'9'.repeat(64)}`, candidateTag: 'company-ai-foundation-knowledge-connector:goal7-candidate-goal7-fixture', candidateImageId: `sha256:${'a'.repeat(64)}` },
      hLite: { previousTag: 'company-ai-foundation-h-lite:goal7-pre-goal7-fixture', previousImageId: `sha256:${'b'.repeat(64)}`, candidateTag: 'company-ai-foundation-h-lite:goal7-candidate-goal7-fixture', candidateImageId: `sha256:${'c'.repeat(64)}` },
    },
    closedCapabilities: { collectorStarted: false, productionShadowStarted: false, formalP2Creation: false, employeeDelivery: false, erpWriteback: false, socialWriteback: false, causalActivation: false },
  }
  const preparationBytes = Buffer.from(JSON.stringify(preparation))
  await fs.writeFile(path.join(bundleRoot, 'preparation-evidence.json'), preparationBytes)
  await fs.writeFile(path.join(bundleRoot, 'migration-012-evidence.json'), JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-migration-012',
    companyQnapIdentity: 'qnap:company/prnas/TS-X65',
    runId: 'goal7-fixture',
    appliedAt: '2026-08-11T09:14:00Z',
    sourceCommit,
    hLiteSourceCommit,
    preparationEvidence: { file: 'preparation-evidence.json', sha256: sha256(preparationBytes) },
    migrationFileSha256: 'd'.repeat(64),
    checks: { tableCount: 4, forcedRlsCount: 4, tenantPolicyCount: 4, appPrivilegeCount: 10, deletePrivilegeCount: 0, bannedColumnCount: 0, appRoleReadVerified: true },
    closedCapabilities: { collectorStarted: false, productionShadowStarted: false, formalP2Creation: false, employeeDelivery: false, erpWriteback: false, socialWriteback: false, causalActivation: false },
  }))
  await fs.writeFile(path.join(bundleRoot, 'pre-deployment-state.json'), JSON.stringify(deploymentState({ phase: 'before', capturedAt: '2026-08-11T09:15:00Z', migrationApplied: false, candidate: false })))
  await fs.writeFile(path.join(bundleRoot, 'post-deployment-state.json'), JSON.stringify(deploymentState({ phase: 'after', capturedAt: '2026-08-11T09:20:00Z', migrationApplied: true, candidate: true })))
  await fs.writeFile(path.join(bundleRoot, 'deployment-side-effects.json'), JSON.stringify({
    auditVersion: '1.0.0',
    completed: true,
    windowStart: '2026-08-11T09:10:00Z',
    windowEnd: '2026-08-11T09:25:00Z',
    formalP2Count: 0,
    employeeDeliveryCount: 0,
    erpWritebackCount: 0,
    socialWritebackCount: 0,
    causalActivationCount: 0,
  }))
  await writeGoal7DeploymentEvidence(bundleRoot)
  await writeGoal7OwnerAcceptanceEvidence(bundleRoot, {
    ownerPrincipalRef: 'company-directory:goal7-owner',
    acceptanceRef: 'feishu:doc/goal7-owner-acceptance',
    acceptedAt: '2026-08-11T10:00:00Z',
  })
  const goal7File = path.join(bundleRoot, 'goal7-acceptance.json')
  await writeGoal7AcceptanceEvidence(bundleRoot, goal7File)
  return { bundleRoot, goal7File }
}

export async function createReadyInputs() {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-readiness-'))
  const releaseRoot = path.join(outputRoot, 'release')
  await fs.mkdir(releaseRoot)
  const sourceBytes = Buffer.from('source archive')
  const hLiteSourceBytes = Buffer.from('h-lite source archive')
  const imageBytes = Buffer.from('collector image archive')
  const componentVersionsBytes = Buffer.from(`${JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-runtime-component-versions',
    sourceCommit: 'a'.repeat(40),
    hLiteSourceCommit: 'f'.repeat(40),
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
  })}\n`)
  await fs.writeFile(path.join(releaseRoot, 'source.tar.gz'), sourceBytes)
  await fs.writeFile(path.join(releaseRoot, 'h-lite-source.tar.gz'), hLiteSourceBytes)
  await fs.writeFile(path.join(releaseRoot, 'collector-image.tar.gz'), imageBytes)
  await fs.writeFile(path.join(releaseRoot, 'runtime-component-versions.json'), componentVersionsBytes)
  await fs.writeFile(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({
    manifestVersion: '1.3.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    createdAt: '2026-08-11T00:00:00Z',
    sourceCommit: 'a'.repeat(40),
    hLiteSourceCommit: 'f'.repeat(40),
    collectorImageId: `sha256:${'b'.repeat(64)}`,
    sourceArchiveSha256: sha256(sourceBytes),
    hLiteSourceArchiveSha256: sha256(hLiteSourceBytes),
    collectorImageArchiveSha256: sha256(imageBytes),
    runtimeComponentVersionsSha256: sha256(componentVersionsBytes),
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
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

  const { acceptanceFile: reviewerRoleAccessFile } = await createReviewerRoleAccessBundle(outputRoot)

  const { goal7File } = await createGoal7AcceptanceBundle(outputRoot)

  return { outputRoot, releaseRoot, registryFile, collectorConfigFile, p003ReviewFile, reviewerRoleAccessFile, goal7File }
}
