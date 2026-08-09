import { assessEvidencePackage, buildEvidencePackageV2 } from './evidence-package.mjs'
import { formatEmployeeAnswer, validateStructuredResponse } from './response-validator.mjs'
import { createWorkCaseDraft } from './work-protocol.mjs'

function stripHiddenReasoning(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:reasoning|thoughts)[\s\S]*?```/gi, '')
    .trim()
    .slice(0, 12_000)
}

export function createCompanyBrain({ store, runtime, admission, config, now = () => new Date() } = {}) {
  const protocol = config?.workProtocol || { mode: 'off', ontologyVersion: '3.1.0', evidenceMaxAgeDays: 180 }

  async function legacyRun({ scope, turn }) {
    const evidence = await store.permissionedSearch({
      tenantId: scope.tenantId,
      personId: scope.personId,
      query: turn.message,
      limit: 8,
    })
    const release = await admission.acquire()
    try {
      const result = await runtime.run({ ...turn, requestId: scope.requestId, evidence })
      return {
        reply: stripHiddenReasoning(result.reply),
        evidence,
        runtime: result.runtime,
        permissionFiltered: true,
        workCase: null,
        answer: null,
      }
    } finally {
      release()
    }
  }

  async function execute({ scope, turn }) {
    if (protocol.mode === 'off') return legacyRun({ scope, turn })
    const draft = createWorkCaseDraft({
      requestId: scope.requestId,
      personId: scope.personId,
      turn,
      processingMode: protocol.mode,
      now,
    })
    const workCase = await store.createWorkCase({ tenantId: scope.tenantId, draft })
    let currentStatus = workCase.status
    const advance = async (toStatus, stageType, options = {}) => {
      const result = await store.advanceWorkCase({
        tenantId: scope.tenantId,
        caseId: workCase.caseId,
        toStatus,
        stageType,
        ...options,
      })
      currentStatus = result.status
      return result
    }

    try {
      await advance('scoped', 'scope', {
        outputReferences: [`work-mode:${draft.workMode}`, `risk:${draft.riskLevel}`],
      })
      if (!workCase.principalFound) {
        await advance('authority_checked', 'authority', {
          stageStatus: 'active',
          policyDecisionReference: draft.policySnapshotId,
        })
        await advance('permission_denied', 'authority', {
          stageStatus: 'blocked',
          blockReasonCode: 'principal_not_active',
          policyDecisionReference: draft.policySnapshotId,
        })
        const retrieval = { evidence: [], principalFound: false, excludedReasonCounts: { principal_not_active: 1 }, policyDecisionReference: 'principal-not-active', limit: 8, truncated: false }
        const evidencePackage = buildEvidencePackageV2({
          caseId: workCase.caseId,
          principalId: scope.personId,
          purpose: draft.purpose,
          ontologyVersion: protocol.ontologyVersion,
          retrieval,
          now,
          maxAgeDays: protocol.evidenceMaxAgeDays,
        })
        const assessment = assessEvidencePackage(evidencePackage)
        const validation = validateStructuredResponse({ rawResponse: null, assessment, evidencePackage })
        await store.recordEpistemicAssessment({ tenantId: scope.tenantId, caseId: workCase.caseId, evidencePackage, assessment })
        await store.finalizeWorkCase({
          tenantId: scope.tenantId,
          caseId: workCase.caseId,
          evidenceCount: 0,
          confidenceLevel: assessment.confidenceLevel,
          deterministicConclusionAllowed: false,
          responseValidationStatus: validation.status,
        })
        return {
          reply: formatEmployeeAnswer(validation.response),
          evidence: [],
          evidencePackage,
          assessment,
          answer: validation.response,
          permissionFiltered: true,
          runtime: { provider: 'policy-engine', mode: protocol.mode, productionReady: true },
          workCase: { caseId: workCase.caseId, status: 'permission_denied', workMode: draft.workMode, processingMode: protocol.mode },
        }
      }

      await advance('authority_checked', 'authority', {
        outputReferences: [draft.policySnapshotId],
        policyDecisionReference: draft.policySnapshotId,
      })
      await store.recordWorkStage({
        tenantId: scope.tenantId,
        caseId: workCase.caseId,
        stageType: 'context',
        status: 'completed',
        inputReferences: ['request-summary', 'principal-snapshot'],
        outputReferences: ['minimal-context'],
      })
      await advance('evidence_collecting', 'evidence', { stageStatus: 'active' })
      const retrieval = store.permissionedRetrieve
        ? await store.permissionedRetrieve({ tenantId: scope.tenantId, personId: scope.personId, query: turn.message, limit: 8 })
        : { evidence: await store.permissionedSearch({ tenantId: scope.tenantId, personId: scope.personId, query: turn.message, limit: 8 }), principalFound: true, excludedReasonCounts: {}, limit: 8, truncated: false }
      const evidencePackage = buildEvidencePackageV2({
        caseId: workCase.caseId,
        principalId: scope.personId,
        purpose: draft.purpose,
        ontologyVersion: protocol.ontologyVersion,
        retrieval,
        now,
        maxAgeDays: protocol.evidenceMaxAgeDays,
      })
      const assessment = assessEvidencePackage(evidencePackage)
      await store.recordEpistemicAssessment({ tenantId: scope.tenantId, caseId: workCase.caseId, evidencePackage, assessment })
      await advance(assessment.completeness === 'insufficient' ? 'insufficient_evidence' : 'evidence_ready', 'evidence', {
        stageStatus: 'completed',
        outputReferences: [evidencePackage.packageId],
        policyDecisionReference: evidencePackage.policyDecisionReference,
        blockReasonCode: assessment.completeness === 'insufficient' ? 'insufficient_evidence' : null,
      })
      if (assessment.completeness === 'insufficient') {
        const validation = validateStructuredResponse({ rawResponse: null, assessment, evidencePackage })
        await store.finalizeWorkCase({
          tenantId: scope.tenantId,
          caseId: workCase.caseId,
          evidenceCount: 0,
          confidenceLevel: assessment.confidenceLevel,
          deterministicConclusionAllowed: false,
          responseValidationStatus: validation.status,
        })
        return {
          reply: formatEmployeeAnswer(validation.response),
          evidence: [],
          evidencePackage,
          assessment,
          answer: validation.response,
          permissionFiltered: true,
          runtime: { provider: 'policy-engine', mode: protocol.mode, productionReady: true },
          workCase: { caseId: workCase.caseId, status: 'insufficient_evidence', workMode: draft.workMode, processingMode: protocol.mode },
        }
      }
      await advance('synthesizing', 'synthesis', {
        stageStatus: 'active',
        inputReferences: [evidencePackage.packageId, `assessment:${assessment.confidenceLevel}`],
      })

      const release = await admission.acquire()
      let result
      try {
        result = await runtime.run({
          ...turn,
          requestId: scope.requestId,
          evidence: retrieval.evidence,
          workContext: {
            processingMode: protocol.mode,
            caseId: workCase.caseId,
            workMode: draft.workMode,
            evidencePackage,
            assessment,
          },
        })
      } finally {
        release()
      }

      let reply
      let answer = null
      let responseValidationStatus = 'shadow'
      if (protocol.mode === 'active') {
        const validation = validateStructuredResponse({ rawResponse: result.reply, assessment, evidencePackage })
        answer = validation.response
        reply = formatEmployeeAnswer(answer)
        responseValidationStatus = validation.status
      } else {
        reply = stripHiddenReasoning(result.reply)
      }
      await store.recordWorkStage({
        tenantId: scope.tenantId,
        caseId: workCase.caseId,
        stageType: 'synthesis',
        status: 'completed',
        inputReferences: [evidencePackage.packageId],
        outputReferences: [`answer-basis:${assessment.confidenceLevel}`],
      })
      await advance('response_ready', 'response', { stageStatus: 'active', inputReferences: [`answer-basis:${assessment.confidenceLevel}`] })
      await store.completeWorkCase({
        tenantId: scope.tenantId,
        caseId: workCase.caseId,
        evidenceCount: evidencePackage.facts.length,
        confidenceLevel: assessment.confidenceLevel,
        deterministicConclusionAllowed: assessment.deterministicConclusionAllowed,
        responseValidationStatus,
      })
      currentStatus = 'completed'
      return {
        reply,
        evidence: retrieval.evidence,
        evidencePackage,
        assessment,
        answer,
        permissionFiltered: true,
        runtime: result.runtime,
        workCase: { caseId: workCase.caseId, status: currentStatus, workMode: draft.workMode, processingMode: protocol.mode },
      }
    } catch (error) {
      if (!['permission_denied', 'completed', 'blocked'].includes(currentStatus)) {
        const stageType = currentStatus === 'synthesizing' ? 'synthesis' : 'evidence'
        await advance('blocked', stageType, { stageStatus: 'blocked', blockReasonCode: String(error?.code || 'work_protocol_failed').slice(0, 80) }).catch(() => {})
      }
      throw error
    }
  }

  return { execute }
}
