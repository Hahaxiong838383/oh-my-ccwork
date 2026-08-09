import test from 'node:test'
import assert from 'node:assert/strict'

import { formatEmployeeAnswer, validateStructuredResponse } from '../src/response-validator.mjs'

const evidencePackage = {
  facts: [{ evidenceId: 'evidence:1' }],
  assumptions: [],
  unknowns: [],
  excludedReasonCounts: {},
}

test('结构化回答只允许引用当前权限证据', () => {
  const result = validateStructuredResponse({
    assessment: { completeness: 'sufficient', contradictionStatus: 'none', freshnessStatus: 'fresh', confidenceLevel: 'medium', deterministicConclusionAllowed: true },
    evidencePackage,
    rawResponse: JSON.stringify({
      conclusion: '结论', factBasis: ['事实'], derivedSummary: '摘要', assumptions: [], contradictions: [], unknowns: [],
      confidenceLevel: 'medium', validityWindow: { validUntil: null }, recommendedNextAction: '继续验证', approvalRequired: false,
      evidenceReferences: ['evidence:1'],
    }),
  })
  assert.equal(result.valid, true)
  assert.match(formatEmployeeAnswer(result.response), /结论/)
})

test('越权引用、隐藏思维链或证据不足的高置信回答必须降级', () => {
  const result = validateStructuredResponse({
    assessment: { completeness: 'insufficient', contradictionStatus: 'none', freshnessStatus: 'unknown', confidenceLevel: 'insufficient', deterministicConclusionAllowed: false },
    evidencePackage: { facts: [], assumptions: [], unknowns: [{ impact: '没有可用证据' }], excludedReasonCounts: { permission_denied: 1 } },
    rawResponse: JSON.stringify({ conclusion: '确定成功', confidenceLevel: 'high', evidenceReferences: ['secret:1'], chainOfThought: '隐藏过程' }),
  })
  assert.equal(result.valid, false)
  assert.equal(result.status, 'fallback')
  assert.ok(result.violations.includes('hidden_reasoning_field_forbidden'))
  assert.ok(result.violations.includes('evidence_reference_not_authorized'))
  assert.match(result.response.conclusion, /授权证据/)
  assert.doesNotMatch(JSON.stringify(result.response), /secret:1|隐藏过程/)
})
