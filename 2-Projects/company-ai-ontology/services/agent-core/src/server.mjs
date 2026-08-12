import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { loadConfig } from './config.mjs'
import { parseTurnBody, sha256, verifySignedRequest } from './protocol.mjs'
import { createHEngineRuntime } from './runtime.mjs'
import { createPostgresStore } from './store.mjs'
import { createAdmissionController } from './admission.mjs'
import { createCompanyBrain } from './company-brain.mjs'
import { createCompanySystemStatusProvider } from './system-status.mjs'
import { ACTIVE_STAGES, CONTRACT_ONLY_STAGES, ONTOLOGY_SCHEMA_VERSION, WORK_PROTOCOL_VERSION, createWorkCaseDraft } from './work-protocol.mjs'
import { compileConversationAuthority } from './authority.mjs'

export const AGENT_CORE_CONTRACT_VERSION = '2026-08-12.3'

function json(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

function safeEqual(actual, expected) {
  const got = Buffer.from(String(actual || ''))
  const want = Buffer.from(String(expected || ''))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      throw Object.assign(new Error('request body is too large'), { statusCode: 413, code: 'payload_too_large' })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function replayStatus(payload) {
  return payload?.status === 'runtime_not_ready' ? 503 : payload?.ok === false ? 500 : 200
}

function parseJson(body) {
  try {
    return JSON.parse(body)
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400, code: 'invalid_request' })
  }
}

function externalKey(value, fieldName) {
  const text = String(value || '').trim()
  if (!/^[A-Za-z0-9:_-]{8,240}$/.test(text)) {
    throw Object.assign(new Error(`${fieldName} is invalid`), { statusCode: 400, code: 'invalid_request' })
  }
  return text
}

function normalizeAlternatives(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw Object.assign(new Error('alternatives must contain 2 to 8 items'), { statusCode: 400, code: 'invalid_request' })
  }
  return value.map((item) => {
    const title = String(item?.title || '').trim()
    if (!title || title.length > 500) throw Object.assign(new Error('alternative title is invalid'), { statusCode: 400, code: 'invalid_request' })
    return {
      title,
      expectedOutcome: item?.expectedOutcome && typeof item.expectedOutcome === 'object' ? item.expectedOutcome : {},
      projectedOutcome: item?.projectedOutcome && typeof item.projectedOutcome === 'object' ? item.projectedOutcome : {},
      assumptions: Array.isArray(item?.assumptions) ? item.assumptions.slice(0, 20) : [],
      risks: Array.isArray(item?.risks) ? item.risks.slice(0, 20) : [],
      metricImpacts: item?.metricImpacts && typeof item.metricImpacts === 'object' ? item.metricImpacts : {},
      riskScore: item?.riskScore,
    }
  })
}

function evidenceReferences(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw Object.assign(new Error('evidenceReferences must contain 1 to 50 items'), { statusCode: 400, code: 'invalid_request' })
  }
  const output = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  if (!output.length || output.some((item) => item.length > 500)) {
    throw Object.assign(new Error('evidenceReferences are invalid'), { statusCode: 400, code: 'invalid_request' })
  }
  return output
}

function authenticate({ request, body, config, now }) {
  const scope = verifySignedRequest({
    headers: request.headers,
    body,
    secret: config.hmacSecret,
    now: now(),
    maxClockSkewMs: config.maxClockSkewMs,
  })
  if (scope.tenantId !== config.tenantId) {
    throw Object.assign(new Error('tenant is not allowed'), { statusCode: 403, code: 'forbidden' })
  }
  return scope
}

function normalizeDirectoryPeople(input) {
  if (!Array.isArray(input?.people) || input.people.length > 1000) {
    throw Object.assign(new Error('people must be an array with at most 1000 entries'), { statusCode: 400, code: 'invalid_request' })
  }
  const seen = new Set()
  return input.people.map((person) => {
    const personId = String(person?.personId || '').trim()
    const displayName = String(person?.displayName || '').trim()
    const departmentKey = String(person?.departmentKey || '').trim() || null
    if (!/^feishu:[A-Za-z0-9_-]{1,100}$/.test(personId) || !displayName || displayName.length > 128) {
      throw Object.assign(new Error('invalid directory person'), { statusCode: 400, code: 'invalid_request' })
    }
    if (departmentKey && !/^[A-Za-z0-9_-]{1,128}$/.test(departmentKey)) {
      throw Object.assign(new Error('invalid department key'), { statusCode: 400, code: 'invalid_request' })
    }
    if (seen.has(personId)) throw Object.assign(new Error('duplicate directory person'), { statusCode: 400, code: 'invalid_request' })
    seen.add(personId)
    const departmentIds = Array.isArray(person?.attributes?.departmentIds)
      ? person.attributes.departmentIds.map(String).filter((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value)).slice(0, 32)
      : []
    return {
      personId,
      displayName,
      departmentKey,
      attributes: { source: 'feishu-directory', departmentIds },
    }
  })
}

export function createAgentCoreServer({ config, store, runtime, systemStatusProvider: providedSystemStatusProvider, logger = () => {}, now = () => Date.now() } = {}) {
  const admission = createAdmissionController(config.admission || {})
  const systemStatusProvider = providedSystemStatusProvider || createCompanySystemStatusProvider({
    config,
    store,
    runtime,
    agentCoreVersion: AGENT_CORE_CONTRACT_VERSION,
    now: () => new Date(now()),
  })
  const companyBrain = createCompanyBrain({ store, runtime, admission, config, systemStatusProvider, now: () => new Date(now()) })
  let draining = false
  let drainStartedAt = null
  let activeRequests = 0
  const idleWaiters = new Set()

  function notifyIdle() {
    if (activeRequests > 0) return
    for (const resolve of idleWaiters) resolve(true)
    idleWaiters.clear()
  }

  async function waitForIdle(timeoutMs) {
    if (activeRequests === 0) return true
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        idleWaiters.delete(done)
        resolve(false)
      }, Math.max(1, timeoutMs))
      timer.unref?.()
      const done = (idle) => {
        clearTimeout(timer)
        resolve(idle)
      }
      idleWaiters.add(done)
    })
  }

  async function beginDrain({ timeoutMs = 90_000 } = {}) {
    if (!draining) {
      draining = true
      drainStartedAt = new Date(now()).toISOString()
    }
    const drained = await waitForIdle(timeoutMs)
    if (!drained) logger('company Agent Core drain timed out', `activeRequests=${activeRequests}`)
    return { drained, draining, activeRequests, drainStartedAt }
  }

  function resume() {
    draining = false
    drainStartedAt = null
    return { resumed: true, draining, activeRequests }
  }

  const server = http.createServer(async (request, response) => {
    const adminRequest = request.method === 'POST' && ['/v1/admin/drain', '/v1/admin/resume'].includes(request.url)
    const trackedRequest = request.method !== 'GET' && !adminRequest
    let countedRequest = false
    try {
      if (adminRequest) {
        if (!safeEqual(request.headers['x-agent-core-drain-token'], config.hmacSecret)) {
          json(response, 401, { ok: false, status: 'unauthorized' })
          return
        }
        if (request.url === '/v1/admin/resume') {
          json(response, 200, { ok: true, status: 'resumed', ...resume() })
          return
        }
        const result = await beginDrain({ timeoutMs: Math.max(1, Number(request.headers['x-agent-core-drain-timeout-ms'] || 90_000)) })
        json(response, result.drained ? 200 : 503, { ok: result.drained, status: result.drained ? 'drained' : 'drain_timeout', ...result })
        return
      }
      if (draining && trackedRequest) {
        json(response, 503, { ok: false, status: 'draining', message: 'Company Agent Core is draining' })
        return
      }
      if (trackedRequest) {
        activeRequests += 1
        countedRequest = true
      }
      if (request.method === 'GET' && request.url === '/healthz') {
        json(response, 200, {
          ok: true,
          status: 'live',
          component: 'company-agent-core',
          contractVersion: AGENT_CORE_CONTRACT_VERSION,
          sourceCommit: config.sourceCommit || null,
          admission: admission.snapshot(),
          draining,
          activeRequests,
          drainStartedAt,
        })
        return
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        if (draining) {
          json(response, 503, {
            ok: false,
            status: 'draining',
            productionReady: false,
            contractVersion: AGENT_CORE_CONTRACT_VERSION,
            sourceCommit: config.sourceCommit || null,
            draining,
            activeRequests,
            drainStartedAt,
          })
          return
        }
        const [database, engine] = await Promise.all([store.ready(), runtime.ready()])
        const ready = Boolean(database.ready && engine.ready)
        json(response, ready ? 200 : 503, {
          ok: ready,
          status: ready ? (engine.productionReady ? 'ready' : 'demo_ready') : 'runtime_not_ready',
          productionReady: Boolean(ready && engine.productionReady),
          database,
          runtime: engine,
          contractVersion: AGENT_CORE_CONTRACT_VERSION,
          sourceCommit: config.sourceCommit || null,
          workProtocol: {
            mode: config.workProtocol?.mode || 'off',
            protocolVersion: WORK_PROTOCOL_VERSION,
            ontologySchemaVersion: config.workProtocol?.ontologyVersion || ONTOLOGY_SCHEMA_VERSION,
            activeStages: ACTIVE_STAGES,
            contractOnlyStages: CONTRACT_ONLY_STAGES,
          },
          admission: admission.snapshot(),
        })
        return
      }
      if (request.method === 'GET' && request.url === '/status/work-protocol') {
        const status = await store.workProtocolStatus({
          tenantId: config.tenantId,
          limit: config.workProtocol?.recentCaseLimit || 8,
        })
        json(response, 200, {
          ok: true,
          status: config.workProtocol?.mode || 'off',
          protocolVersion: WORK_PROTOCOL_VERSION,
          ontologySchemaVersion: config.workProtocol?.ontologyVersion || ONTOLOGY_SCHEMA_VERSION,
          activeStages: ACTIVE_STAGES,
          contractOnlyStages: CONTRACT_ONLY_STAGES,
          ...status,
        })
        return
      }
      if (request.method === 'GET' && request.url === '/status/practice-protocol') {
        const [status, operationalCounts] = await Promise.all([
          store.practiceProtocolStatus({
            tenantId: config.tenantId,
            limit: config.workProtocol?.recentCaseLimit || 8,
          }),
          store.operationalStatus ? store.operationalStatus({ tenantId: config.tenantId }) : { actionIntents: 0, deliveryOutbox: 0 },
        ])
        json(response, 200, {
          ok: true,
          status: config.practiceProtocol?.mode || 'off',
          protocolVersion: WORK_PROTOCOL_VERSION,
          ontologySchemaVersion: config.workProtocol?.ontologyVersion || ONTOLOGY_SCHEMA_VERSION,
          activeStages: ACTIVE_STAGES,
          contractOnlyStages: CONTRACT_ONLY_STAGES,
          operationalCounts,
          ...status,
        })
        return
      }
      if (request.method === 'POST' && [
        '/v1/retrieve',
        '/v1/decisions/propose',
        '/v1/decisions/approve',
        '/v1/p2/compile',
        '/v1/tasks/transition',
        '/v1/delivery/demo-ack',
        '/v1/p2/tasks',
        '/v1/actions/propose',
        '/v1/learnings/record',
        '/v1/privacy/my-data',
        '/v1/identity/sync',
      ].includes(request.url)) {
        const body = await readBody(request, config.maxBodyBytes)
        const scope = authenticate({ request, body, config, now })
        const input = parseJson(body)
        if ([
          '/v1/decisions/propose',
          '/v1/decisions/approve',
          '/v1/p2/compile',
          '/v1/actions/propose',
          '/v1/learnings/record',
        ].includes(request.url) && (config.practiceProtocol?.mode || 'off') === 'off') {
          throw Object.assign(new Error('practice protocol is disabled'), { statusCode: 503, code: 'practice_protocol_disabled' })
        }
        if (request.url === '/v1/identity/sync') {
          if (scope.personId !== 'company-directory-sync') {
            throw Object.assign(new Error('directory sync requires service identity'), { statusCode: 403, code: 'forbidden' })
          }
          const people = normalizeDirectoryPeople(input)
          const result = await store.syncPrincipals({ tenantId: scope.tenantId, people })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'directory_principals_synced',
            payload: result,
          })
          json(response, 200, { ok: true, status: 'completed', requestId: scope.requestId, ...result })
          return
        }
        if (request.url === '/v1/retrieve') {
          const authority = compileConversationAuthority({
            personId: scope.personId,
            context: input.context,
            purpose: String(input.purpose || 'company_knowledge_query'),
            now: () => new Date(now()),
            maxMembershipAgeMs: config?.authority?.membershipMaxAgeMs,
          })
          if (store.recordConversationAuthoritySnapshot) {
            await store.recordConversationAuthoritySnapshot({
              tenantId: scope.tenantId,
              personId: scope.personId,
              snapshot: authority.snapshot,
            })
          }
          const evidence = await store.permissionedSearch({
            tenantId: scope.tenantId,
            personId: scope.personId,
            query: input.query,
            limit: input.limit,
            authority,
          })
          const excludedReasonCounts = authority.snapshot.decision === 'unknown'
            ? { conversation_membership_unknown: 1 }
            : authority.snapshot.decision === 'deny' ? { conversation_membership_denied: 1 } : {}
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'permissioned_retrieval_completed',
            payload: { evidenceCount: evidence.length, classifications: [...new Set(evidence.map((item) => item.classification))] },
          })
          json(response, 200, {
            ok: true,
            status: 'completed',
            requestId: scope.requestId,
            permissionFiltered: true,
            authoritySnapshot: authority.snapshot,
            excludedReasonCounts,
            evidence,
          })
          return
        }
        if (request.url === '/v1/decisions/propose') {
          const decisionExternalKey = externalKey(input.decisionExternalKey, 'decisionExternalKey')
          const p2ExternalKey = externalKey(input.p2ExternalKey, 'p2ExternalKey')
          const question = String(input.question || '').trim()
          if (!question || question.length > 1000) throw Object.assign(new Error('question is invalid'), { statusCode: 400, code: 'invalid_request' })
          const alternatives = normalizeAlternatives(input.alternatives)
          const references = evidenceReferences(input.evidenceReferences)
          const workCaseDraft = createWorkCaseDraft({
            requestId: scope.requestId,
            personId: scope.personId,
            turn: { conversationId: String(input.conversationId || ''), message: question, intent: 'decision' },
            processingMode: config.workProtocol?.mode || 'active',
            now: () => new Date(now()),
          })
          const workCase = await store.createWorkCase({ tenantId: scope.tenantId, draft: workCaseDraft })
          if (!workCase.principalFound) throw Object.assign(new Error('decision principal is not active'), { statusCode: 403, code: 'forbidden' })
          await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: workCase.caseId, toStatus: 'scoped', stageType: 'scope' })
          await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: workCase.caseId, toStatus: 'authority_checked', stageType: 'authority' })
          await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: workCase.caseId, toStatus: 'evidence_collecting', stageType: 'context' })
          await store.advanceWorkCase({
            tenantId: scope.tenantId,
            caseId: workCase.caseId,
            toStatus: 'evidence_ready',
            stageType: 'evidence',
            inputReferences: references,
            outputReferences: [`evidence-package:${scope.requestId}`],
          })
          await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: workCase.caseId, toStatus: 'synthesizing', stageType: 'synthesis' })
          await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: workCase.caseId, toStatus: 'response_ready', stageType: 'response' })
          await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: workCase.caseId, toStatus: 'decision_pending', stageType: 'decision', stageStatus: 'active' })
          const decisionCase = await store.proposeDecision({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            workCaseId: workCase.caseId,
            decisionExternalKey,
            p2ExternalKey,
            question,
            purpose: String(input.purpose || 'company-priority-decision'),
            riskLevel: ['low', 'medium', 'high', 'critical'].includes(input.riskLevel) ? input.riskLevel : 'high',
            evidencePackageId: `evidence-package:${scope.requestId}`,
            alternatives,
          })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'decision_case_proposed',
            payload: { decisionExternalKey, p2ExternalKey, workCaseId: workCase.caseId, alternativeCount: alternatives.length },
          })
          json(response, 200, { ok: true, status: decisionCase.status, requestId: scope.requestId, workCaseId: workCase.caseId, decisionCase })
          return
        }
        if (request.url === '/v1/decisions/approve') {
          const decision = await store.approveDecision({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            decisionExternalKey: externalKey(input.decisionExternalKey, 'decisionExternalKey'),
            selectedAlternativeExternalKey: externalKey(input.selectedAlternativeExternalKey, 'selectedAlternativeExternalKey'),
            rationale: String(input.rationale || ''),
            approvalEvidenceReferences: evidenceReferences(input.approvalEvidenceReferences),
            expectedOutcome: input.expectedOutcome && typeof input.expectedOutcome === 'object' ? input.expectedOutcome : {},
          })
          if (decision.workCaseId && !decision.replayed) {
            await store.advanceWorkCase({
              tenantId: scope.tenantId,
              caseId: decision.workCaseId,
              toStatus: 'decision_approved',
              stageType: 'decision',
              outputReferences: [`decision:${decision.id}`],
            })
            await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: decision.workCaseId, toStatus: 'planning', stageType: 'plan', stageStatus: 'active' })
          }
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'decision_approved',
            payload: {
              decisionId: decision.id,
              p2ExternalKey: decision.p2ExternalKey,
              workCaseId: decision.workCaseId,
              replayed: Boolean(decision.replayed),
            },
          })
          json(response, 200, { ok: true, status: decision.status, requestId: scope.requestId, decision })
          return
        }
        if (request.url === '/v1/p2/compile') {
          const tasks = await store.compileP2({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            p2ExternalKey: externalKey(input.p2ExternalKey, 'p2ExternalKey'),
            decisionExternalKey: externalKey(input.decisionExternalKey, 'decisionExternalKey'),
            assigneePersonIds: Array.isArray(input.assigneePersonIds) ? input.assigneePersonIds.map(String) : [],
            assigneeCount: input.assigneeCount,
          })
          const workCaseId = tasks[0]?.work_case_id || null
          if (workCaseId) {
            await store.advanceWorkCase({
              tenantId: scope.tenantId,
              caseId: workCaseId,
              toStatus: 'plan_ready',
              stageType: 'plan',
              outputReferences: tasks.map((task) => `task:${task.id}`),
            })
            await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: workCaseId, toStatus: 'executing', stageType: 'execution', stageStatus: 'active' })
          }
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'p2_tasks_compiled',
            payload: { p2ExternalKey: input.p2ExternalKey, decisionExternalKey: input.decisionExternalKey, taskCount: tasks.length, workCaseId },
          })
          json(response, 200, { ok: true, status: 'draft', requestId: scope.requestId, tasks })
          return
        }
        if (request.url === '/v1/tasks/transition') {
          const task = await store.transitionTask({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            taskExternalKey: String(input.taskExternalKey || ''),
            action: String(input.action || '').trim().toLowerCase(),
            resultText: input.resultText,
            suppressDelivery: input.suppressDelivery === true,
          })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'task_transition_completed',
            payload: { taskExternalKey: task.external_key, status: task.status, deliverySuppressed: input.suppressDelivery === true },
          })
          json(response, 200, { ok: true, status: task.status, requestId: scope.requestId, task })
          return
        }
        if (request.url === '/v1/delivery/demo-ack') {
          const deliveries = await store.ackDemoDeliveries({ tenantId: scope.tenantId })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'demo_deliveries_acked',
            payload: { count: deliveries.length, simulation: true },
          })
          json(response, 200, { ok: true, status: 'acked', requestId: scope.requestId, deliveries })
          return
        }
        if (request.url === '/v1/actions/propose') {
          const action = await store.createActionIntent({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            targetSystem: String(input.targetSystem || ''),
            actionType: String(input.actionType || ''),
            payload: input.payload,
            riskLevel: String(input.riskLevel || 'low'),
            idempotencyKey: scope.idempotencyKey,
            decisionExternalKey: externalKey(input.decisionExternalKey, 'decisionExternalKey'),
            taskExternalKey: externalKey(input.taskExternalKey || input.payload?.taskExternalKey, 'taskExternalKey'),
          })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'action_intent_proposed',
            payload: { actionIntentId: action.id, targetSystem: action.target_system, actionType: action.action_type, decisionId: action.decision_id, taskId: action.task_id },
          })
          json(response, 200, { ok: true, status: action.status, requestId: scope.requestId, action })
          return
        }
        if (request.url === '/v1/learnings/record') {
          const learning = await store.recordLearning({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            decisionExternalKey: externalKey(input.decisionExternalKey, 'decisionExternalKey'),
            verificationId: String(input.verificationId || ''),
            finding: String(input.finding || ''),
            causeCategory: ['assumption', 'execution', 'operation', 'market', 'measurement', 'unknown'].includes(input.causeCategory) ? input.causeCategory : 'unknown',
            recommendedChange: input.recommendedChange && typeof input.recommendedChange === 'object' ? input.recommendedChange : {},
            changeScope: ['none', 'task', 'process', 'policy', 'ontology'].includes(input.changeScope) ? input.changeScope : 'none',
          })
          if (learning.work_case_id) {
            await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: learning.work_case_id, toStatus: 'verification_pending', stageType: 'execution' })
            await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: learning.work_case_id, toStatus: 'verified', stageType: 'verification', outputReferences: [`verification:${input.verificationId}`] })
            await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: learning.work_case_id, toStatus: 'learning', stageType: 'learning', stageStatus: 'active' })
            await store.advanceWorkCase({ tenantId: scope.tenantId, caseId: learning.work_case_id, toStatus: 'completed', stageType: 'learning', outputReferences: [`learning:${learning.id}`] })
          }
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'decision_learning_recorded',
            payload: { learningId: learning.id, verificationId: input.verificationId, decisionExternalKey: input.decisionExternalKey },
          })
          json(response, 200, { ok: true, status: learning.status, requestId: scope.requestId, learning })
          return
        }
        if (request.url === '/v1/privacy/my-data') {
          const data = await store.personDataSummary({ tenantId: scope.tenantId, personId: scope.personId })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'personal_data_summary_viewed',
            payload: { simulation: Boolean(data.simulation) },
          })
          json(response, 200, { ok: true, status: 'completed', requestId: scope.requestId, data })
          return
        }
        const tasks = await store.listP2Tasks({
          tenantId: scope.tenantId,
          p2ExternalKey: String(input.p2ExternalKey || 'demo-p2-2026-001'),
        })
        json(response, 200, { ok: true, status: 'completed', requestId: scope.requestId, tasks })
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/turns') {
        json(response, 404, { ok: false, status: 'not_found' })
        return
      }

      const body = await readBody(request, config.maxBodyBytes)
      const scope = authenticate({ request, body, config, now })
      const turn = parseTurnBody(body)
      const requestHash = sha256(body)
      const namespace = 'agent-turn-v1'
      const claim = await store.claim({
        tenantId: scope.tenantId,
        namespace,
        idempotencyKey: scope.idempotencyKey,
        requestHash,
        expiresAt: new Date(now() + config.idempotencyTtlSeconds * 1000),
      })
      if (claim.kind === 'conflict') {
        json(response, 409, { ok: false, status: 'idempotency_conflict', requestId: scope.requestId })
        return
      }
      if (claim.kind === 'in_progress') {
        json(response, 409, { ok: false, status: 'request_in_progress', requestId: scope.requestId })
        return
      }
      if (claim.kind === 'replay') {
        json(response, replayStatus(claim.response), claim.response, { 'x-company-idempotent-replay': '1' })
        return
      }

      await store.audit({
        tenantId: scope.tenantId,
        requestId: scope.requestId,
        personId: scope.personId,
        eventType: 'agent_turn_received',
        payload: { intent: turn.intent, channel: turn.channel, requestHash },
      })

      const readiness = await runtime.ready()
      if (!readiness.ready && (config.workProtocol?.mode || 'off') === 'off') {
        const payload = {
          ok: false,
          status: 'runtime_not_ready',
          message: 'Company H Engine runtime is not ready',
          requestId: scope.requestId,
          runtime: readiness,
        }
        await store.finish({ tenantId: scope.tenantId, namespace, idempotencyKey: scope.idempotencyKey, status: 'failed', response: payload })
        await store.audit({
          tenantId: scope.tenantId,
          requestId: scope.requestId,
          personId: scope.personId,
          eventType: 'agent_turn_runtime_not_ready',
          payload: { reason: readiness.reason || 'unknown' },
        })
        json(response, 503, payload)
        return
      }

      try {
        const result = await companyBrain.execute({ scope, turn })
        const payload = {
          ok: true,
          status: 'completed',
          requestId: scope.requestId,
          reply: String(result.reply || ''),
          permissionFiltered: result.permissionFiltered === true,
          evidence: result.evidence || [],
          evidencePackage: result.evidencePackage || null,
          epistemicAssessment: result.assessment || null,
          answer: result.answer || null,
          workCase: result.workCase || null,
          runtime: result.runtime || readiness,
        }
        await store.finish({ tenantId: scope.tenantId, namespace, idempotencyKey: scope.idempotencyKey, status: 'completed', response: payload })
        await store.audit({
          tenantId: scope.tenantId,
          requestId: scope.requestId,
          personId: scope.personId,
          eventType: 'agent_turn_completed',
          payload: {
            provider: payload.runtime?.provider || 'unknown',
            evidenceCount: payload.evidence.length,
            workCaseId: payload.workCase?.caseId || null,
            workCaseStatus: payload.workCase?.status || null,
            confidenceLevel: payload.epistemicAssessment?.confidenceLevel || null,
          },
        })
        json(response, 200, payload)
      } catch (error) {
        const payload = {
          ok: false,
          status: String(error?.code || 'runtime_failed'),
          message: 'Company H Engine runtime failed',
          requestId: scope.requestId,
        }
        await store.finish({ tenantId: scope.tenantId, namespace, idempotencyKey: scope.idempotencyKey, status: 'failed', response: payload })
        await store.audit({
          tenantId: scope.tenantId,
          requestId: scope.requestId,
          personId: scope.personId,
          eventType: payload.status === 'runtime_not_ready' ? 'agent_turn_runtime_not_ready' : 'agent_turn_failed',
          payload: { code: payload.status },
        })
        logger('agent turn failed', scope.requestId, payload.status)
        json(response, Number(error?.statusCode || 502), payload)
      }
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500)
      if (statusCode >= 500) logger('request failed', String(error?.message || error).slice(0, 160))
      json(response, statusCode, {
        ok: false,
        status: String(error?.code || 'internal_error'),
        message: statusCode >= 500 ? 'internal server error' : String(error?.message || error),
      })
    } finally {
      if (countedRequest) {
        activeRequests -= 1
        notifyIdle()
      }
    }
  })
  server.beginDrain = beginDrain
  server.resumeIntake = resume
  server.drainSnapshot = () => ({ draining, activeRequests, drainStartedAt })
  return server
}

export async function startAgentCore(env = process.env) {
  const config = loadConfig(env)
  const logger = (...args) => console.error(new Date().toISOString(), ...args)
  const store = createPostgresStore({ database: config.database, logger })
  const usageLedger = {
    readDaily: ({ date, routeKey }) => store.runtimeUsageDaily({ tenantId: config.tenantId, date, routeKey }),
    record: ({ context, runtime, outcome }) => store.recordRuntimeUsage({
      tenantId: config.tenantId,
      requestId: context.requestId,
      caseId: context.caseId,
      personId: context.personId,
      workType: context.workType,
      runtime,
      outcome,
    }),
  }
  const runtime = createHEngineRuntime({ config: config.runtime, usageLedger })
  const server = createAgentCoreServer({ config, store, runtime, logger })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  logger('company-agent-core listening', `${config.host}:${config.port}`, AGENT_CORE_CONTRACT_VERSION)
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    const result = await server.beginDrain({ timeoutMs: Math.max(1, Number(env.AGENT_CORE_DRAIN_TIMEOUT_MS || 90_000)) })
    await new Promise((resolve) => server.close(resolve))
    await store.close()
    process.exit(result.drained ? 0 : 1)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return { server, store, runtime, config }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startAgentCore().catch((error) => {
    console.error(new Date().toISOString(), 'company-agent-core startup failed', String(error?.message || error))
    process.exit(1)
  })
}
