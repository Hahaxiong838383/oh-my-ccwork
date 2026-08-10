import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyPestimSourceRegistryContract,
  compilePestimSourceRegistryProposal,
  evaluateSourceCollectionPolicy,
  loadPestimSourceRegistryCatalog,
  loadPestimSourceRegistryContract,
  validateSourceRegistryCatalog,
} from '../src/index.mjs'

const PESTIM_A_HASH = 'e254ee1f82d985828e50b6148b9ffd22f6f0e0ce920ebe75ff6bc6e55d9a5410'
const EVALUATED_AT = new Date('2026-08-10T12:00:00Z')

function approvedEntry(entry, overrides = {}) {
  const result = structuredClone(entry)
  result.lifecycleStatus = 'enabled'
  result.license.status = 'approved'
  result.governance.approvalStatus = 'approved'
  result.governance.approvedBy = 'company-compliance-dri:test-fixture'
  result.governance.approvedAt = '2026-08-10T08:00:00Z'
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.')
    const last = keys.pop()
    const target = keys.reduce((current, key) => current[key], result)
    target[last] = value
  }
  return result
}

test('P1-SI-B compiles as an additive contract without changing P1-SI-A', async () => {
  const proposal = await compilePestimSourceRegistryProposal()
  assert.equal(proposal.strategicIntelligence.candidate.schemaVersion, '3.4.0')
  assert.equal(proposal.strategicIntelligence.candidate.contentHash, PESTIM_A_HASH)
  assert.equal(proposal.baseline.schemaVersion, '3.4.0')
  assert.equal(proposal.baseline.contentHash, PESTIM_A_HASH)
  assert.equal(proposal.candidate.schemaVersion, '3.5.0')
  assert.equal(proposal.contract.status, 'contract_only')
  assert.equal(proposal.contract.deploymentAllowed, false)
  assert.equal(proposal.compatibility.classification, 'compatible')
  assert.equal(proposal.candidate.counts.object_type - proposal.baseline.counts.object_type, 2)
  assert.equal(proposal.candidate.counts.link_type - proposal.baseline.counts.link_type, 3)
  assert.equal(proposal.candidate.counts.function_type - proposal.baseline.counts.function_type, 2)
  assert.equal(proposal.candidate.counts.action_type - proposal.baseline.counts.action_type, 0)
  assert.equal(proposal.candidate.counts.policy_type - proposal.baseline.counts.policy_type, 3)
  assert.equal(proposal.candidate.counts.constraint_type - proposal.baseline.counts.constraint_type, 5)
  assert.ok(proposal.compatibility.changes.every((change) => change.severity === 'compatible'))
})

test('initial source catalog is structurally valid but fail-closed pending company approval', async () => {
  const contract = await loadPestimSourceRegistryContract()
  const { catalog, validation } = await loadPestimSourceRegistryCatalog({ contract })
  assert.equal(validation.ok, true)
  assert.equal(validation.entryCount, 8)
  assert.match(validation.contentHash, /^[a-f0-9]{64}$/)
  assert.ok(catalog.entries.every((entry) => entry.lifecycleStatus === 'paused'))
  assert.ok(catalog.entries.every((entry) => entry.license.status === 'pending'))
  assert.ok(catalog.entries.every((entry) => entry.governance.approvalStatus === 'pending'))
  for (const entry of catalog.entries) {
    const decision = evaluateSourceCollectionPolicy(catalog, contract, entry.sourceKey, EVALUATED_AT)
    assert.equal(decision.allowed, false)
    assert.equal(decision.reasonCode, 'SOURCE_PAUSED')
  }
})

test('source policy allows only a registered enabled licensed and approved source', async () => {
  const contract = await loadPestimSourceRegistryContract()
  const { catalog } = await loadPestimSourceRegistryCatalog({ contract })
  const source = approvedEntry(catalog.entries[0])
  const approvedCatalog = { ...structuredClone(catalog), entries: [source] }
  const decision = evaluateSourceCollectionPolicy(approvedCatalog, contract, source.sourceKey, EVALUATED_AT)
  assert.equal(decision.allowed, true)
  assert.equal(decision.reasonCode, 'SOURCE_APPROVED')
  assert.equal(decision.collection.credentialMode, 'none')
  assert.equal(decision.retention.storageLevel, 'summary_metadata')
  assert.deepEqual(decision.internalUseScopes, source.internalUseScopes)
})

test('source policy denies unregistered, revoked, unapproved and expired sources', async () => {
  const contract = await loadPestimSourceRegistryContract()
  const { catalog } = await loadPestimSourceRegistryCatalog({ contract })
  const base = approvedEntry(catalog.entries[0])

  assert.equal(
    evaluateSourceCollectionPolicy({ ...catalog, entries: [base] }, contract, 'unknown-source', EVALUATED_AT).reasonCode,
    'SOURCE_NOT_REGISTERED',
  )

  const revoked = structuredClone(base)
  revoked.lifecycleStatus = 'revoked'
  assert.equal(
    evaluateSourceCollectionPolicy({ ...catalog, entries: [revoked] }, contract, revoked.sourceKey, EVALUATED_AT).reasonCode,
    'SOURCE_REVOKED',
  )

  const unapproved = structuredClone(base)
  unapproved.governance.approvalStatus = 'pending'
  unapproved.governance.approvedBy = null
  unapproved.governance.approvedAt = null
  assert.equal(
    evaluateSourceCollectionPolicy({ ...catalog, entries: [unapproved] }, contract, unapproved.sourceKey, EVALUATED_AT).reasonCode,
    'COMPLIANCE_NOT_APPROVED',
  )

  const expired = approvedEntry(base, { 'license.expiresAt': '2026-08-09T23:59:59Z' })
  assert.equal(
    evaluateSourceCollectionPolicy({ ...catalog, entries: [expired] }, contract, expired.sourceKey, EVALUATED_AT).reasonCode,
    'LICENSE_EXPIRED',
  )
})

test('source policy denies personal accounts, login, bypass and unlicensed full text', async () => {
  const contract = await loadPestimSourceRegistryContract()
  const { catalog } = await loadPestimSourceRegistryCatalog({ contract })
  const base = approvedEntry(catalog.entries[0])
  const cases = [
    ['collection.credentialMode', 'personal', 'PERSONAL_ACCOUNT_FORBIDDEN'],
    ['collection.requiresLogin', true, 'LOGIN_REQUIRED_FORBIDDEN'],
    ['collection.antiAutomationBypass', true, 'ANTI_AUTOMATION_BYPASS_FORBIDDEN'],
    ['retention.storageLevel', 'full_text', 'FULL_TEXT_RETENTION_NOT_APPROVED'],
  ]
  for (const [path, value, expected] of cases) {
    const source = approvedEntry(base, { [path]: value })
    const decision = evaluateSourceCollectionPolicy({ ...catalog, entries: [source] }, contract, source.sourceKey, EVALUATED_AT)
    assert.equal(decision.allowed, false)
    assert.equal(decision.reasonCode, expected)
  }
})

test('invalid registry snapshots fail closed and duplicate proposal elements are rejected', async () => {
  const contract = await loadPestimSourceRegistryContract()
  const proposal = await compilePestimSourceRegistryProposal()
  const { catalog } = await loadPestimSourceRegistryCatalog({ contract })
  const invalid = structuredClone(catalog)
  invalid.entries.push(structuredClone(invalid.entries[0]))
  const validation = validateSourceRegistryCatalog(invalid, contract)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.includes('duplicates')))
  assert.equal(evaluateSourceCollectionPolicy(invalid, contract, invalid.entries[0].sourceKey, EVALUATED_AT).reasonCode, 'REGISTRY_INVALID')

  const collidingContract = structuredClone(contract)
  collidingContract.additions.objectTypes[0].qualifiedName = 'domain.intelligence.ExternalFactor'
  assert.throws(
    () => applyPestimSourceRegistryContract(proposal.baseline.definition, collidingContract),
    /proposal collides with existing objectTypes domain\.intelligence\.ExternalFactor/,
  )
})
