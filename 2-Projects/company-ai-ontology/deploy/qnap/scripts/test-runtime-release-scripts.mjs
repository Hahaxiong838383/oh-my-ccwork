import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const agentDeployUrl = new URL('./deploy-agent-runtime.sh', import.meta.url)
const agentRollbackUrl = new URL('./rollback-agent-runtime.sh', import.meta.url)
const domainDeployUrl = new URL('./deploy-domain-runtime.sh', import.meta.url)
const domainRollbackUrl = new URL('./rollback-domain-runtime.sh', import.meta.url)

test('Agent Core 独立发布只重建 agent-core 并具备自动恢复', async () => {
  const source = await readFile(agentDeployUrl, 'utf8')
  assert.match(source, /AGENT_RUNTIME_EXPECTED_VERSION:-2026-08-10\.2/)
  assert.match(source, /\[ "\$\(hostname\)" = PRNas \]/)
  assert.match(source, /refusing unexpected company ontology root/)
  assert.match(source, /image tag company-ai-foundation-agent-core:latest "\$previous_image"/)
  assert.match(source, /current agent runtime version is unavailable/)
  assert.match(source, /rollback_on_error\(\)/)
  assert.match(source, /compose build agent-core/)
  assert.match(source, /compose up -d agent-core/)
  assert.doesNotMatch(source, /compose build (?:ontology-registry|domain-connector|action-gateway)/)
  assert.match(source, /p\.productionReady===true&&p\.contractVersion===process\.argv\[1\]/)
  assert.match(source, /inspect --format '\{\{\.RestartCount\}\}'/)
  assert.match(source, /"\$previous_version"/)
})

test('Agent Core 独立回滚恢复环境、旧镜像和生产就绪状态', async () => {
  const source = await readFile(agentRollbackUrl, 'utf8')
  assert.match(source, /AGENT_RUNTIME_BACKUP_ROOT/)
  assert.match(source, /cp "\$backup_root\/\.env" "\$project_root\/\.env"/)
  assert.match(source, /image tag "\$previous_image" company-ai-foundation-agent-core:latest/)
  assert.match(source, /compose up -d --no-build agent-core/)
  assert.match(source, /p\.productionReady===true/)
  assert.match(source, /restored_version/)
})

test('Domain Connector 独立发布与回滚保持最小变更面', async () => {
  const [deploy, rollback] = await Promise.all([
    readFile(domainDeployUrl, 'utf8'),
    readFile(domainRollbackUrl, 'utf8'),
  ])
  assert.match(deploy, /DOMAIN_RUNTIME_EXPECTED_VERSION:-2026-08-10\.1/)
  assert.match(deploy, /current domain runtime version is unavailable/)
  assert.match(deploy, /refusing unexpected company ontology root/)
  assert.match(deploy, /compose build domain-connector/)
  assert.match(deploy, /compose up -d domain-connector/)
  assert.doesNotMatch(deploy, /compose build (?:agent-core|ontology-registry|action-gateway)/)
  assert.match(deploy, /inspect --format '\{\{\.RestartCount\}\}'/)
  assert.match(rollback, /compose up -d --no-build domain-connector/)
  assert.match(rollback, /inspect --format '\{\{\.RestartCount\}\}'/)
})
