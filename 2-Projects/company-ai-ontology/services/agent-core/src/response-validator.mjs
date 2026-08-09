const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low', 'insufficient'])
const FORBIDDEN_KEYS = new Set([
  'chainofthought', 'chain_of_thought', 'reasoning', 'reasoningcontent', 'reasoning_content',
  'thoughts', 'hiddenreasoning', 'hidden_reasoning', '思维链', '推理过程',
])

function text(value, max = 4000) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}

function strings(value, maxItems = 20, maxLength = 1000) {
  if (!Array.isArray(value)) return []
  return value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, maxItems)
}

function hasForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasForbiddenKey)
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key.toLowerCase()) || hasForbiddenKey(child))
}

function parseStructured(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  const source = String(raw || '').trim()
  if (!source || /<think>|<\/think>/i.test(source)) return null
  const candidates = [source]
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(source.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return null
}

function fallbackResponse({ assessment, evidencePackage }) {
  const permissionDenied = Number(evidencePackage?.excludedReasonCounts?.permission_denied || 0) > 0
  const noEvidence = (evidencePackage?.facts?.length || 0) === 0
  const conflicting = assessment?.contradictionStatus === 'conflicting'
  const stale = ['stale', 'mixed'].includes(assessment?.freshnessStatus)
  let conclusion = '当前可用证据不足，无法形成确定性结论。'
  if (permissionDenied && noEvidence) conclusion = '当前没有可供你使用的授权证据，无法基于公司资料形成结论。'
  else if (conflicting) conclusion = '当前证据存在冲突，暂不建议形成确定性结论。'
  else if (stale) conclusion = '当前证据包含过期信息，需要补充最新资料后再判断。'
  return {
    conclusion,
    factBasis: [],
    derivedSummary: '系统依据权限、时效、冲突和证据覆盖规则执行了保守降级。',
    assumptions: strings(evidencePackage?.assumptions?.map((item) => item.statement || item.code)),
    contradictions: conflicting ? ['存在相互冲突的权限化证据'] : [],
    unknowns: strings(evidencePackage?.unknowns?.map((item) => item.impact || item.code)),
    confidenceLevel: assessment?.confidenceLevel || 'insufficient',
    validityWindow: assessment?.validityWindow || { validUntil: null },
    recommendedNextAction: permissionDenied
      ? '如需访问受限资料，请申请相应权限；涉及个人权限操作请使用自己的私人 Bot。'
      : '补充最新且可授权访问的证据后重新发起分析。',
    approvalRequired: false,
    evidenceReferences: [],
  }
}

export function validateStructuredResponse({ rawResponse, assessment, evidencePackage } = {}) {
  const parsed = parseStructured(rawResponse)
  const allowedEvidence = new Set(evidencePackage?.facts?.map((item) => item.evidenceId) || [])
  const violations = []
  if (!parsed) violations.push('response_not_structured_json')
  if (hasForbiddenKey(parsed) || /<think>|<\/think>|chain[_ -]?of[_ -]?thought/i.test(String(rawResponse || ''))) {
    violations.push('hidden_reasoning_field_forbidden')
  }
  if (parsed && !text(parsed.conclusion)) violations.push('conclusion_required')
  const confidenceLevel = text(parsed?.confidenceLevel, 32).toLowerCase()
  if (parsed && !CONFIDENCE_LEVELS.has(confidenceLevel)) violations.push('confidence_level_invalid')
  const evidenceReferences = strings(parsed?.evidenceReferences, 50, 180)
  if (evidenceReferences.some((reference) => !allowedEvidence.has(reference))) violations.push('evidence_reference_not_authorized')
  if (assessment?.deterministicConclusionAllowed !== true && ['high', 'medium'].includes(confidenceLevel)) {
    violations.push('unsupported_certainty')
  }
  if (assessment?.completeness === 'insufficient' && strings(parsed?.unknowns).length === 0) {
    violations.push('unknowns_required_for_insufficient_evidence')
  }
  if (assessment?.contradictionStatus === 'conflicting' && strings(parsed?.contradictions).length === 0) {
    violations.push('contradictions_required')
  }
  if (violations.length > 0) {
    return { valid: false, status: 'fallback', violations, response: fallbackResponse({ assessment, evidencePackage }) }
  }
  return {
    valid: true,
    status: 'valid',
    violations: [],
    response: {
      conclusion: text(parsed.conclusion),
      factBasis: strings(parsed.factBasis),
      derivedSummary: text(parsed.derivedSummary, 3000),
      assumptions: strings(parsed.assumptions),
      contradictions: strings(parsed.contradictions),
      unknowns: strings(parsed.unknowns),
      confidenceLevel,
      validityWindow: parsed.validityWindow && typeof parsed.validityWindow === 'object' && !Array.isArray(parsed.validityWindow)
        ? { validUntil: text(parsed.validityWindow.validUntil, 80) || null }
        : { validUntil: null },
      recommendedNextAction: text(parsed.recommendedNextAction, 1500),
      approvalRequired: parsed.approvalRequired === true,
      evidenceReferences,
    },
  }
}

export function formatEmployeeAnswer(answer) {
  const sections = [answer.conclusion]
  if (answer.factBasis?.length) sections.push(`依据：\n- ${answer.factBasis.join('\n- ')}`)
  if (answer.assumptions?.length) sections.push(`假设：\n- ${answer.assumptions.join('\n- ')}`)
  if (answer.contradictions?.length) sections.push(`冲突：\n- ${answer.contradictions.join('\n- ')}`)
  if (answer.unknowns?.length) sections.push(`未知与限制：\n- ${answer.unknowns.join('\n- ')}`)
  if (answer.recommendedNextAction) sections.push(`建议下一步：${answer.recommendedNextAction}`)
  sections.push(`置信等级：${answer.confidenceLevel}`)
  return sections.filter(Boolean).join('\n\n').slice(0, 12_000)
}
