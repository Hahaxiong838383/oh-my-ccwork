import assert from 'node:assert/strict'
import {
  isHorizonDigestReport,
  sanitizeHorizonDigestPayload,
} from '../src/lib/radar/horizon.ts'

const payload = sanitizeHorizonDigestPayload(
  {
    type: 'horizon',
    publish: true,
    date: '2026-07-22',
    generatedAt: '2026-07-22T02:00:00Z',
    totalFetched: 38,
    sourceCount: 5,
    realtimeDuplicateCount: 3,
    relevanceFilteredCount: 2,
    items: [
      {
        id: 'hn:1',
        title: '新的多模态模型发布',
        titleEn: 'A new multimodal model',
        url: 'https://example.com/model',
        source: 'Example Lab',
        sourceType: 'rss',
        publishedAt: '2026-07-22T01:00:00Z',
        score: 12,
        summary: '模型在端侧推理效率方面取得进展。',
        whyItMatters: '它降低了实时多模态交互的部署门槛。',
        tags: ['multimodal', 'edge-ai'],
        category: 'ai-models',
        references: [
          { title: '官方说明', url: 'https://example.com/source' },
          { title: '危险链接', url: 'javascript:alert(1)' },
        ],
      },
    ],
  },
  new Date('2026-07-22T03:00:00Z'),
)

assert.ok(payload)
assert.equal(payload.publish, true)
assert.equal(payload.report.generatedAt, '2026-07-22T03:00:00.000Z')
assert.equal(payload.report.items.length, 1)
assert.equal(payload.report.items[0].score, 10)
assert.equal(payload.report.items[0].references.length, 1)
assert.equal(payload.report.items[0].category, 'ai-models')
assert.equal(payload.report.realtimeDuplicateCount, 3)
assert.equal(payload.report.relevanceFilteredCount, 2)
assert.equal(isHorizonDigestReport(payload.report), true)

assert.equal(
  sanitizeHorizonDigestPayload({
    type: 'horizon',
    date: '../etc/passwd',
    items: [],
  }),
  null,
)
assert.equal(
  sanitizeHorizonDigestPayload({
    type: 'horizon',
    date: '2026-07-22',
    items: [{ title: 'bad', url: 'javascript:alert(1)', summary: 'bad' }],
  }),
  null,
)

console.log('Horizon radar contract: all assertions passed')
