/** Actual config-store contract: absent policy must preserve the old device snapshot. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const dir = mkdtempSync(join(tmpdir(), 'voice-idle-policy-'));
process.env.CONFIG_DB_PATH = join(dir, 'singleton.db');
const { ConfigStore } = await import('../src/config-store.js');
const SN_A = 'BJP00326110799999901';
const SN_B = 'BJP00326110799999902';
const KEY = 'voice.session_idle_timeout_ms';
let counter = 0;
const fresh = () => new ConfigStore(join(dir, `${++counter}.db`));

test('unconfigured devices retain the prior snapshot without a new default idle policy', () => {
  const store = fresh();
  assert.equal(store.effectiveSnapshot(SN_A).voice, undefined);
});
test('explicit idle milliseconds are delivered with the device config revision', () => {
  const store = fresh();
  assert.notEqual(store.setValue(SN_A, KEY, 300_000), null);
  const snapshot = store.effectiveSnapshot(SN_A);
  assert.deepEqual(snapshot.voice, { session_idle_timeout_ms: 300_000 });
  assert.notEqual(snapshot.revision, 'cfg-0');
  assert.equal(store.effectiveSnapshot(SN_B).voice, undefined);
});
test('global and per-device precedence remain consistent; tombstones restore the global value', () => {
  const store = fresh();
  assert.notEqual(store.setGlobal(KEY, 300_000), null);
  assert.notEqual(store.setValue(SN_A, KEY, 5000), null);
  assert.deepEqual(store.effectiveSnapshot(SN_A).voice, { session_idle_timeout_ms: 5000 });
  assert.deepEqual(store.effectiveSnapshot(SN_B).voice, { session_idle_timeout_ms: 300_000 });
  const before = store.effectiveSnapshot(SN_A).revision;
  assert.notEqual(store.clearForSn(SN_A, KEY), null);
  assert.deepEqual(store.effectiveSnapshot(SN_A).voice, { session_idle_timeout_ms: 300_000 });
  assert.notEqual(store.effectiveSnapshot(SN_A).revision, before);
});
test('no-policy zero is omitted, and invalid units or ranges cannot enter snapshots', () => {
  const store = fresh();
  assert.notEqual(store.setValue(SN_A, KEY, 0), null);
  assert.equal(store.effectiveSnapshot(SN_A).voice, undefined);
  for (const value of [null, -1, 1, 4999, 300001, 5000.5, '5000', true, {}]) {
    assert.equal(store.setValue(SN_A, KEY, value), null);
  }
});
