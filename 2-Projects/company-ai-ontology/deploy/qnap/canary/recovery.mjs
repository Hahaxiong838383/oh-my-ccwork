import { DatabaseSync } from 'node:sqlite'
import { createCompanyAgentCoreClient } from '/app/lib/company-agent-core-client.mjs'

const runId = process.env.CANARY_RUN_ID
const client = createCompanyAgentCoreClient({ baseUrl: process.env.H_AGENT_CORE_URL, secret: process.env.H_AGENT_CORE_SECRET })
const ready = await client.ready()
const tasks = await client.listP2Tasks({
  tenantId: process.env.FUTURUS_TENANT_ID,
  personId: 'demo-dri-01',
  requestId: `${runId}-recovery-tasks`,
  idempotencyKey: `${runId}-recovery-tasks`,
  p2ExternalKey: 'demo-p2-2026-001',
})
const db = new DatabaseSync(process.env.H_SQLITE_STATE_FILE, { readOnly: true })
const durable = db.prepare(`
  SELECT event_type, count(*) AS count
  FROM durable_events
  WHERE event_type IN ('p0_demo_cycle_completed', 'p0_action_cycle_completed')
  GROUP BY event_type ORDER BY event_type
`).all()
db.close()
const acceptedCount = tasks.tasks.filter((task) => task.status === 'accepted').length
console.log(JSON.stringify({ runId, ready: ready.ok, readyStatus: ready.payload?.status, acceptedCount, taskCount: tasks.tasks.length, durable }))
if (!ready.ok || tasks.tasks.length !== 10 || acceptedCount !== 10 || durable.length < 2) process.exitCode = 1
