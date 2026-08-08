import { createCompanyAgentCoreClient } from '/app/lib/company-agent-core-client.mjs'

const runId = process.env.CANARY_RUN_ID || `canary-${Date.now()}`
const levels = String(process.env.CANARY_LEVELS || '5,10,20').split(',').map(Number).filter((value) => value > 0)
const hLiteUrl = 'http://127.0.0.1:8081'
const client = createCompanyAgentCoreClient({
  baseUrl: process.env.H_AGENT_CORE_URL,
  secret: process.env.H_AGENT_CORE_SECRET,
})

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] || 0
}

async function turn(level, index) {
  const personId = `demo-person-${String((index % 10) + 1).padStart(2, '0')}`
  const requestId = `${runId}-${level}-${index}`
  const started = performance.now()
  const response = await fetch(`${hLiteUrl}/v1/shadow/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-h-lite-shadow-token': process.env.H_LITE_SHADOW_TOKEN },
    body: JSON.stringify({ personId, requestId, conversationId: requestId, message: `Canary ${level}/${index} 查询公司协作手册`, intent: 'query' }),
  })
  const payload = await response.json()
  return { status: response.status, ok: response.ok && payload.ok, simulation: payload.runtime?.simulation === true, latencyMs: Math.round(performance.now() - started) }
}

const load = []
for (const level of levels) {
  const results = await Promise.all(Array.from({ length: level }, (_, index) => turn(level, index)))
  load.push({
    concurrency: level,
    success: results.filter((item) => item.ok).length,
    simulation: results.filter((item) => item.simulation).length,
    httpStatuses: [...new Set(results.map((item) => item.status))],
    p50Ms: percentile(results.map((item) => item.latencyMs), 0.5),
    p95Ms: percentile(results.map((item) => item.latencyMs), 0.95),
    maxMs: Math.max(...results.map((item) => item.latencyMs)),
  })
}

const permissions = []
for (let index = 1; index <= 10; index += 1) {
  const personId = `demo-person-${String(index).padStart(2, '0')}`
  const result = await client.retrieve({ tenantId: process.env.FUTURUS_TENANT_ID, personId, requestId: `${runId}-permission-${index}`, idempotencyKey: `${runId}-permission-${index}`, query: '经营预算', limit: 8 })
  permissions.push({ personId, restrictedCount: result.evidence.filter((item) => item.classification === 'restricted').length })
}
const dri = await client.retrieve({ tenantId: process.env.FUTURUS_TENANT_ID, personId: 'demo-dri-01', requestId: `${runId}-permission-dri`, idempotencyKey: `${runId}-permission-dri`, query: '经营预算', limit: 8 })
const unknown = await client.retrieve({ tenantId: process.env.FUTURUS_TENANT_ID, personId: 'unknown-person', requestId: `${runId}-permission-unknown`, idempotencyKey: `${runId}-permission-unknown`, query: '经营预算', limit: 8 })
const personalData = await client.myData({ tenantId: process.env.FUTURUS_TENANT_ID, personId: 'demo-person-01', requestId: `${runId}-my-data`, idempotencyKey: `${runId}-my-data` })

console.log(JSON.stringify({
  runId,
  simulation: true,
  load,
  permissionNegativePass: permissions.every((item) => item.restrictedCount === 0) && unknown.evidence.length === 0,
  permissionPositivePass: dri.evidence.some((item) => item.classification === 'restricted'),
  permissions,
  driRestrictedCount: dri.evidence.filter((item) => item.classification === 'restricted').length,
  unknownEvidenceCount: unknown.evidence.length,
  personalData: personalData.data,
}))

if (
  load.some((item) => item.success !== item.concurrency || item.simulation !== item.concurrency)
  || !permissions.every((item) => item.restrictedCount === 0)
  || !dri.evidence.some((item) => item.classification === 'restricted')
  || unknown.evidence.length !== 0
  || personalData.data.privateConversationStoredInOntology !== false
  || personalData.data.managerCanReadPrivateConversation !== false
) process.exitCode = 1
