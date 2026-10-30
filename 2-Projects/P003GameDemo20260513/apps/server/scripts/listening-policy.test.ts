import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultListeningSettings, parseListeningSettings, updateListeningSettings, listeningEligible, LISTENING_CAPABILITY } from '../src/listening-policy.js';
const sn = 'BJP00326070803800006';
const settings = { version: 1, enabled: true, allowlist: [sn] };
const device = { sn, accountId: 'test-account', active: true };
const supports = [LISTENING_CAPABILITY];
test('默认关闭、空名单关闭，合法完整身份与双端能力才可签发', () => {
  assert.deepEqual(defaultListeningSettings(), { version: 1, enabled: false, allowlist: [] });
  assert.equal(listeningEligible(defaultListeningSettings(), device, supports, true), false);
  assert.equal(listeningEligible({ ...settings, allowlist: [] }, device, supports, true), false);
  assert.equal(listeningEligible(settings, device, supports, true), true);
  assert.equal(listeningEligible(settings, device, supports, false), false);
  assert.equal(listeningEligible(settings, device, [], true), false);
  assert.equal(listeningEligible(settings, { ...device, active: false }, supports, true), false);
  assert.equal(listeningEligible(settings, { ...device, accountId: '' }, supports, true), false);
  assert.equal(listeningEligible(settings, { ...device, sn: sn.slice(-8) }, supports, true), false);
  assert.equal(listeningEligible(settings, null, supports, true), false);
});
test('非法类型、未知字段、截短SN、重复名单、错误版本拒绝', () => {
  for (const value of [null, [], {}, { ...settings, version: 0 }, { ...settings, version: 1.5 },
    { ...settings, version: Number.MAX_SAFE_INTEGER + 1 }, { ...settings, enabled: 'true' },
    { ...settings, surprise: true }, { ...settings, allowlist: ['03800006'] },
    { ...settings, allowlist: [sn, sn] }, { ...settings, allowlist: ['*'] }]) {
    assert.equal(parseListeningSettings(value), null, JSON.stringify(value));
    assert.equal(listeningEligible(value, device, supports, true), false);
  }
});
test('设置返回独立快照，CAS版本不允许旧编辑覆盖新值', () => {
  const copy = parseListeningSettings(settings)!; copy.allowlist.length = 0;
  assert.equal(settings.allowlist.length, 1);
  const updated = updateListeningSettings(settings, 1, { enabled: false, allowlist: [] });
  assert.deepEqual(updated, { version: 2, enabled: false, allowlist: [] });
  assert.throws(() => updateListeningSettings(updated, 1, { enabled: true, allowlist: [sn] }), /version_conflict/);
  assert.throws(() => updateListeningSettings(settings, 1, { enabled: true, allowlist: [sn], version: 20 }), /invalid/);
  assert.throws(() => updateListeningSettings({ ...settings, version: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER, { enabled: false, allowlist: [] }), /version_exhausted/);
});
test('不接受继承字段或稀疏名单数组', () => {
  const inherited = Object.assign(Object.create(settings), { a: 1, b: 2, c: 3 });
  assert.equal(parseListeningSettings(inherited), null);
  assert.equal(parseListeningSettings({ ...settings, allowlist: Array(1) }), null);
});
