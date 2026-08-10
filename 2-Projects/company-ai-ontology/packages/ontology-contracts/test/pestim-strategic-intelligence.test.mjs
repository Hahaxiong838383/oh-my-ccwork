import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyPestimStrategicIntelligenceContract,
  compilePestimStrategicIntelligenceProposal,
  loadPestimStrategicIntelligenceContract,
} from '../src/index.mjs'

test('P1-SI-A compiles as an additive candidate without changing production schema', async () => {
  const proposal = await compilePestimStrategicIntelligenceProposal()
  assert.equal(proposal.baseline.schemaVersion, '3.3.0')
  assert.equal(proposal.candidate.schemaVersion, '3.4.0')
  assert.equal(proposal.contract.status, 'contract_only')
  assert.equal(proposal.contract.deploymentAllowed, false)
  assert.equal(proposal.compatibility.classification, 'compatible')
  assert.equal(proposal.candidate.counts.object_type - proposal.baseline.counts.object_type, 6)
  assert.equal(proposal.candidate.counts.link_type - proposal.baseline.counts.link_type, 10)
  assert.equal(proposal.candidate.counts.function_type - proposal.baseline.counts.function_type, 3)
  assert.equal(proposal.candidate.counts.action_type - proposal.baseline.counts.action_type, 0)
  assert.equal(proposal.candidate.counts.policy_type - proposal.baseline.counts.policy_type, 4)
  assert.equal(proposal.candidate.counts.constraint_type - proposal.baseline.counts.constraint_type, 4)
  assert.ok(proposal.compatibility.changes.every((change) => change.severity === 'compatible'))
})

test('P1-SI-A keeps imported matrix hypotheses unverified, inactive and non-autonomous', async () => {
  const contract = await loadPestimStrategicIntelligenceContract()
  assert.deepEqual(contract.activationDefaults, {
    generationStatus: 'generated_draft',
    verificationStatus: 'unverified',
    activationStatus: 'inactive',
  })
  for (const operation of [
    'create_formal_p2',
    'assign_employee_task',
    'write_erp',
    'write_social_system',
    'activate_impact_hypothesis',
  ]) assert.ok(contract.forbiddenAutonomy.includes(operation))
  assert.equal(contract.additions.actionTypes.length, 0)
  assert.ok(contract.additions.policyTypes.some((item) => item.qualifiedName === 'domain.intelligence.noAutomaticP2'))
  assert.ok(contract.additions.constraintTypes.some((item) => item.qualifiedName === 'domain.intelligence.activationRequiresDriReview'))
})

test('P1-SI-A rejects proposal collisions with the active definition', async () => {
  const proposal = await compilePestimStrategicIntelligenceProposal()
  const contract = structuredClone(proposal.contract)
  contract.additions.objectTypes[0].qualifiedName = 'core.work.Task'
  assert.throws(
    () => applyPestimStrategicIntelligenceContract(proposal.baseline.definition, contract),
    /proposal collides with existing objectTypes core\.work\.Task/,
  )
})
