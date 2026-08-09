export const ERP_FRESH_SUPPORT_FIXTURE = Object.freeze({
  evidenceId: 'erp-fixture:order-001',
  source: 'aishike-erp-fixture',
  objectType: 'order',
  title: 'Fixture 订单状态',
  excerpt: 'Fixture 订单已完成质检和出库准备。',
  classification: 'internal',
  updatedAt: '2026-08-09T01:00:00Z',
  validUntil: '2026-08-10T01:00:00Z',
  permissionSnapshot: true,
  supports: true,
})

export const SOCIAL_CONTRADICTION_FIXTURE = Object.freeze({
  evidenceId: 'social-fixture:signal-001',
  source: 'social-monitor-fixture',
  objectType: 'market_signal',
  title: 'Fixture 市场反证',
  excerpt: 'Fixture 用户反馈显示目标体验仍未改善。',
  classification: 'internal',
  updatedAt: '2026-08-09T01:10:00Z',
  validUntil: '2026-08-10T01:10:00Z',
  permissionSnapshot: true,
  contradicts: true,
})

export const ERP_STALE_FIXTURE = Object.freeze({
  evidenceId: 'erp-fixture:stale-001',
  source: 'aishike-erp-fixture',
  objectType: 'inventory',
  title: 'Fixture 过期库存',
  excerpt: 'Fixture 库存快照已超过有效期。',
  classification: 'internal',
  updatedAt: '2026-07-01T01:00:00Z',
  validUntil: '2026-07-02T01:00:00Z',
  permissionSnapshot: true,
})

export const UNAUTHORIZED_RETRIEVAL_FIXTURE = Object.freeze({
  principalFound: true,
  evidence: [],
  excludedReasonCounts: { permission_denied: 4 },
  policyDecisionReference: 'fixture-deny-policy',
  limit: 8,
  truncated: false,
})
