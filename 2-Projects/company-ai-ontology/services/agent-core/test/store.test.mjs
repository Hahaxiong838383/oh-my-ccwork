import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSearchTerms } from '../src/store.mjs'

test('自然语言查询提取英文标识与中文关键词', () => {
  const terms = buildSearchTerms('请告诉我公司出差报销标准，校验码 ONTOLOGY_KNOWLEDGE_E2E_20260808 是什么？')
  assert.ok(terms.includes('ontology_knowledge_e2e_20260808'))
  assert.ok(terms.includes('出差'))
  assert.ok(terms.includes('报销'))
  assert.ok(terms.includes('标准'))
  assert.equal(terms.includes('什么'), false)
})

test('检索词数量受限且忽略单字符噪声', () => {
  const terms = buildSearchTerms('a 我 ' + '公司经营目标任务成果证据权限审批流程'.repeat(8), 10)
  assert.equal(terms.length, 10)
  assert.equal(terms.includes('a'), false)
})
