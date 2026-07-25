import assert from 'node:assert/strict'
import {
  classifyTraffic,
  getPrefetchReason,
  isPublicPagePath,
  isStaticAssetPath,
  parseIpList,
} from '../src/lib/analytics/classify.ts'

const config = {
  ownerIps: parseIpList('203.0.113.10'),
  aiopsIps: parseIpList('198.51.100.20'),
}
const browserUa =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36'

assert.deepEqual(
  classifyTraffic({ path: '/', ip: '203.0.113.1', ua: browserUa, source: 'client' }, config),
  { kind: 'human', reason: 'browser_hydrated' },
)
assert.equal(
  classifyTraffic({ path: '/about', ip: '203.0.113.10', ua: browserUa, source: 'client' }, config).kind,
  'owner',
)
assert.equal(
  classifyTraffic({ path: '/', ip: '198.51.100.20', ua: 'curl/8.5.0', source: 'middleware' }, config).kind,
  'aiops',
)
assert.equal(
  classifyTraffic({ path: '/', ip: '203.0.113.1', ua: 'Uptime-Kuma/1.23.17', source: 'middleware' }, config).kind,
  'aiops',
)
assert.equal(
  classifyTraffic({ path: '/wp-admin/install.php', ip: '203.0.113.1', ua: browserUa, source: 'middleware' }, config).kind,
  'bot',
)
assert.equal(
  classifyTraffic({ path: '/radar', ip: '203.0.113.1', ua: 'curl/8.5.0', source: 'middleware' }, config).kind,
  'bot',
)
assert.deepEqual(
  classifyTraffic(
    {
      path: '/videos',
      ip: '203.0.113.1',
      ua: browserUa,
      source: 'middleware',
      prefetchReason: 'next_router_prefetch',
    },
    config,
  ),
  { kind: 'prefetch', reason: 'next_router_prefetch' },
)
assert.equal(isPublicPagePath('/work/example-project'), true)
assert.equal(isPublicPagePath('/writing/example-post?from=home'), true)
assert.equal(isPublicPagePath('/.env'), false)
assert.equal(isStaticAssetPath('/media/demo.mp4'), true)
assert.equal(isStaticAssetPath('/wp-admin/install.php'), false)
assert.equal(
  getPrefetchReason(new Headers({ 'next-router-prefetch': '1' })),
  'next_router_prefetch',
)

console.log('analytics classification: all assertions passed')
