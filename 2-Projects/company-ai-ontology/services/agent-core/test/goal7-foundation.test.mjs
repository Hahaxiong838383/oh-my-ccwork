import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const migrationUrl = new URL('../../../deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql', import.meta.url)
const validatorUrl = new URL('../../../deploy/qnap/scripts/validate-goal7-foundation-isolated.sh', import.meta.url)
const workflowUrl = new URL('../../../../../.github/workflows/p1-si-runtime-verify.yml', import.meta.url)
const storeUrl = new URL('../src/store.mjs', import.meta.url)
const composeUrl = new URL('../../../deploy/qnap/docker-compose.yml', import.meta.url)
const agentDockerfileUrl = new URL('../Dockerfile', import.meta.url)
const connectorDockerfileUrl = new URL('../../knowledge-connector/Dockerfile', import.meta.url)

test('Goal 7 候选迁移定义双时间成员、会话授权、路由状态与无正文预算审计', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8')
  for (const table of [
    'iam.principal_memberships',
    'work.conversation_authority_snapshots',
    'runtime.h_engine_route_state',
    'runtime.h_engine_usage_events',
  ]) assert.match(sql, new RegExp(table.replace('.', '\\.')))
  assert.match(sql, /valid_from timestamptz NOT NULL/)
  assert.match(sql, /observed_at timestamptz NOT NULL/)
  assert.match(sql, /FORCE ROW LEVEL SECURITY/)
  assert.match(sql, /route_key IN \('route-a', 'route-b'\)/)
  assert.doesNotMatch(sql, /prompt_text|request_body|response_body|employee_question/)
  assert.match(sql, /REVOKE DELETE/)
})

test('Goal 7 检索 SQL 只在当前群成员证据成立时使用 chat ACL 且用途只收窄', async () => {
  const store = await fs.readFile(storeUrl, 'utf8')
  assert.match(store, /r\.metadata->'allowedPurposes' \? \$8/)
  assert.match(store, /a\.subject_type IN \('chat', 'group'\)/)
  assert.match(store, /AND \$10 = true/)
  assert.match(store, /a\.subject_key = \$9/)
  assert.match(store, /INSERT INTO work\.conversation_authority_snapshots/)
  assert.match(store, /INSERT INTO runtime\.h_engine_usage_events/)
  assert.doesNotMatch(store, /prompt_text|request_body|response_body/)
})

test('Goal 7 PostgreSQL 隔离验证进入不可变 Runtime Workflow', async () => {
  const [validator, workflow] = await Promise.all([
    fs.readFile(validatorUrl, 'utf8'),
    fs.readFile(workflowUrl, 'utf8'),
  ])
  assert.match(validator, /goal7_candidate_migration=verified/)
  assert.match(validator, /goal7_acl_fail_closed=verified/)
  assert.match(validator, /goal7_app_role_rw=%s/)
  assert.match(validator, /route-a:true,route-b:false/)
  assert.match(workflow, /validate-goal7-foundation-isolated\.sh/)
  assert.match(workflow, /goal7-foundation-validation\.txt/)
  assert.match(workflow, /goal7_app_role_rw=verified/)
  assert.match(workflow, /goal7FoundationEvidenceSha256/)
  assert.match(workflow, /postgresEvidenceSha256/)
  assert.match(workflow, /h_lite_source_commit/)
  assert.match(workflow, /h-lite-source\.tar\.gz/)
  assert.match(workflow, /hLiteSourceArchiveSha256/)
  assert.match(workflow, /company-qnap-lite-service\.test\.mjs/)
  assert.match(workflow, /npm test --prefix "\$project\/services\/agent-core"/)
  assert.match(workflow, /npm test --prefix "\$project\/services\/knowledge-connector"/)
})

test('Goal 7 三个运行组件通过镜像标签与健康读回绑定双仓 Commit', async () => {
  const [compose, agentDockerfile, connectorDockerfile] = await Promise.all([
    fs.readFile(composeUrl, 'utf8'),
    fs.readFile(agentDockerfileUrl, 'utf8'),
    fs.readFile(connectorDockerfileUrl, 'utf8'),
  ])
  assert.match(compose, /ONTOLOGY_SOURCE_COMMIT: \$\{ONTOLOGY_SOURCE_COMMIT:-unknown\}/)
  assert.match(compose, /H_LITE_SOURCE_COMMIT: \$\{H_LITE_SOURCE_COMMIT:-unknown\}/)
  assert.match(agentDockerfile, /org\.opencontainers\.image\.revision=\$\{ONTOLOGY_SOURCE_COMMIT\}/)
  assert.match(connectorDockerfile, /org\.opencontainers\.image\.revision=\$\{ONTOLOGY_SOURCE_COMMIT\}/)
})
