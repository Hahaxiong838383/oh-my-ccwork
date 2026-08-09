import fs from 'node:fs/promises'

const CONTRACT_URL = new URL('../contracts/company-capability-governance-v1.json', import.meta.url)
const REQUIRED_OBJECTS = new Set([
  'CapabilityDefinition',
  'CapabilityRelease',
  'CapabilityBinding',
  'CapabilityOverride',
  'CapabilityExecutionSnapshot',
])

export async function loadCompanyCapabilityGovernance(file = CONTRACT_URL) {
  const model = JSON.parse(await fs.readFile(file, 'utf8'))
  const errors = []
  if (!/^\d+\.\d+\.\d+$/.test(String(model.contractVersion || ''))) errors.push('contractVersion must be semantic version')
  if (model.status !== 'contract_only') errors.push('status must remain contract_only before production activation')
  if (model.canonicalStores?.skillBody !== 'git-and-h-platform-l0-store') errors.push('skill bodies must remain outside the business ontology')
  if (model.canonicalStores?.governanceMetadata !== 'ontology-registry') errors.push('governance metadata must use ontology-registry')
  const objectNames = new Set((model.governedObjects || []).map((item) => item.name))
  for (const name of REQUIRED_OBJECTS) if (!objectNames.has(name)) errors.push(`missing governed object ${name}`)
  if (model.forkPolicy?.requireCanonicalBody !== true) errors.push('fork policy must require canonical body')
  if (model.forkPolicy?.requireSourceHashMatch !== true) errors.push('fork policy must require source hash match')
  if (model.forkPolicy?.rejectCorePersonalShadow !== true) errors.push('fork policy must reject core personal shadow')
  if (model.forkPolicy?.rejectCoreNoncanonicalShadow !== true) errors.push('fork policy must reject every noncanonical core shadow')
  const companyCore = (model.capabilityClasses || []).find((item) => item.id === 'company-core')
  if (!companyCore || companyCore.personalOverrideAllowed !== false || companyCore.sameNameShadowAllowed !== false) {
    errors.push('company-core capability must reject personal override and same-name shadow')
  }
  const channelIds = new Set((model.releaseChannels || []).map((item) => item.id))
  for (const id of ['skill-content-hot-publish', 'h-control-code-release', 'h-runtime-release']) {
    if (!channelIds.has(id)) errors.push(`missing release channel ${id}`)
  }
  if (errors.length > 0) throw new Error(`invalid company capability governance contract: ${errors.join('; ')}`)
  return model
}

export function evaluateCapabilityOverride(model, proposal = {}) {
  if (proposal.capabilityClass === 'company-core' && proposal.overrideLayer !== 'company-canonical') {
    return { allowed: false, reason: 'core_noncanonical_shadow_denied' }
  }
  if (model.forkPolicy?.requireCanonicalBody === true && proposal.canonicalBodyPresent !== true) {
    return { allowed: false, reason: 'hollow_fork_denied' }
  }
  if (model.forkPolicy?.requireSourceHashMatch === true && proposal.sourceHashMatches !== true) {
    return { allowed: false, reason: 'source_hash_mismatch' }
  }
  if (model.forkPolicy?.requireApproval === true && proposal.approved !== true) {
    return { allowed: false, reason: 'approval_required' }
  }
  return { allowed: true, reason: 'approved_override' }
}

export function validateCapabilityExecutionSnapshot(model, snapshot = {}) {
  const errors = []
  for (const field of model.executionSnapshot?.requiredFields || []) {
    if (snapshot[field] === undefined || snapshot[field] === null || snapshot[field] === '') errors.push(`missing ${field}`)
  }
  for (const field of model.executionSnapshot?.hashFields || []) {
    if (snapshot[field] !== undefined && !/^[0-9a-f]{64}$/.test(String(snapshot[field]))) errors.push(`${field} must be sha256`)
  }
  if ('hiddenReasoning' in snapshot && model.executionSnapshot?.hiddenReasoningAllowed === false) errors.push('hiddenReasoning is forbidden')
  return { ok: errors.length === 0, errors }
}
