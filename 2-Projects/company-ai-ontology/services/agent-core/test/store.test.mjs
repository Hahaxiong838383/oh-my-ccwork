import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSearchTerms, mapKnowledgeEvidence, mapOntologyEvidence } from '../src/store.mjs'

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

test('知识与本体证据保留来源、有效期和反证语义', () => {
  const knowledge = mapKnowledgeEvidence({
    id: 11,
    resource_id: 'resource-1',
    provider: 'fixture',
    resource_type: 'market_signal',
    external_key: 'social-fixture:signal-001',
    title: 'Fixture 市场反证',
    classification: 'internal',
    source_updated_at: '2026-08-09T01:00:00Z',
    content: '体验仍未改善',
    chunk_index: 0,
    metadata: {
      sourceSystem: 'social-monitor-fixture',
      validUntil: '2026-08-10T01:00:00Z',
      contradicts: true,
      simulation: true,
    },
  })
  assert.equal(knowledge.source, 'social-monitor-fixture')
  assert.equal(knowledge.validUntil, '2026-08-10T01:00:00Z')
  assert.equal(knowledge.contradicts, true)
  assert.equal(knowledge.simulation, true)

  const ontology = mapOntologyEvidence({
    id: 'entity-1',
    entity_type: 'order',
    external_key: 'erp-fixture:order-001',
    display_name: 'Fixture 订单状态',
    classification: 'internal',
    updated_at: '2026-08-09T01:00:00Z',
    attributes: {
      summary: '已完成质检',
      sourceSystem: 'aishike-erp-fixture',
      validUntil: '2026-08-10T01:00:00Z',
      supports: true,
      simulation: true,
    },
  })
  assert.equal(ontology.source, 'aishike-erp-fixture')
  assert.equal(ontology.supports, true)
  assert.equal(ontology.permissionSnapshot, true)
})
