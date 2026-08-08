import { createCompanyAgentCoreClient } from '/app/lib/company-agent-core-client.mjs'

const runId = process.env.CANARY_RUN_ID
const client = createCompanyAgentCoreClient({ baseUrl: process.env.H_AGENT_CORE_URL, secret: process.env.H_AGENT_CORE_SECRET })
const result = await client.ackDemoDeliveries({
  tenantId: process.env.FUTURUS_TENANT_ID,
  personId: 'company-h-lite',
  requestId: `${runId}-retry-ack`,
  idempotencyKey: `${runId}-retry-ack`,
})
const canary = result.deliveries.filter((item) => item.event_type === 'canary_retry')
console.log(JSON.stringify({ runId, status: result.status, ackedCount: canary.length, deliveries: canary.map((item) => ({ recipientKey: item.recipient_key, providerMessageId: item.provider_message_id })) }))
if (canary.length !== 1 || !canary[0].provider_message_id) process.exitCode = 1
