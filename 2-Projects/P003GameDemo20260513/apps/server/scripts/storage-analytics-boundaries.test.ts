import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Synthetic admission boundaries only: this is not a device load test.
const root = mkdtempSync(join(tmpdir(), 'analytics-quota-boundaries-'));
process.env.CONFIG_DB_PATH = join(root, 'config.db');
const { configStore: config } = await import('../src/config-store.js');
const { analyticsControlRoute } = await import('../src/analytics/control-route.js');
const subjects = Array.from({ length: 100 }, (_, i) =>
  'BJP003260601' + String(i + 1).padStart(8, '0'));
let capacity = 50;
const setSyntheticProfile = (count: number) => config.setFlag(
  'storage.verified-profile.v1',
  JSON.stringify({ version: 1, analytics_devices: count, ark_devices: 0,
    evidence: 'SYNTHETIC-BOUNDARIES-NOT-LOAD-TEST', candidate: 'test',
    validated_at_ms: Date.now() }), 'test');
setSyntheticProfile(50);

const route = analyticsControlRoute({
  authorize: () => 'admin', internalUrl: 'http://127.0.0.1:3006', internalSecret: 'fake',
  devices: () => subjects.map(sn => ({ sn, note: 'fixture', status: 'active' })),
  policy: () => config.analyticsPolicy(),
  storageRevision: () => config.storagePolicy().revision,
  save: (policy, actor, before, gate) => config.saveAnalyticsPolicy(policy, actor, before, gate),
  fetchImpl: async url => String(url).endsWith('capacity')
    ? Response.json({ ok: true, storage_policy_revision: config.storagePolicy().revision,
      max_enabled_devices: capacity, checked_at_ms: Date.now() })
    : Response.json({ ok: true, enabled: false, subjects: [] }),
});
const enable = (count: number) => route.request('/', {
  method: 'PUT', body: JSON.stringify({
    expected_revision: config.analyticsPolicy()?.revision ?? 0,
    enabled: true, subjects: subjects.slice(0, count), hour: 23,
  }),
});

try {
  for (const count of [32, 33, 49, 50]) {
    assert.equal((await enable(count)).status, 200, 'count=' + count);
  }
  assert.equal((await enable(51)).status, 409);
  assert.equal(config.analyticsPolicy()!.subjects.length, 50);
  config.saveStoragePolicy({ expected_revision: 0, target_devices: 100 },
    () => ({ analytics: config.analyticsPolicy()!.subjects.length, ark: 0 }), 'test');
  assert.equal((await enable(51)).status, 409, 'planning alone cannot widen admission');
  setSyntheticProfile(100);
  capacity = 100;
  assert.equal((await enable(100)).status, 200);
  assert.equal(config.analyticsPolicy()!.subjects.length, 100);
  console.log('PASS: Analytics HTTP/SQLite quota boundaries 32/33/49/50/51/100; synthetic admission, not load proof');
} finally {
  rmSync(root, { recursive: true, force: true });
}
