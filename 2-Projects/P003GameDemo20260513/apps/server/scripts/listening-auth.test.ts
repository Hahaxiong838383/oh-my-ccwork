import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT, decodeJwt } from 'jose';
import { issueListeningGrant, verifyListeningGrant, type ListeningBinding } from '../src/listening-grant.js';
const secret = 'synthetic-listening-test-key-32-bytes-only';
const now = 1_800_000_000_000;
const binding: ListeningBinding = { sn: 'BJP00326070803800006', room: 'sn-BJP00326070803800006-1800000000', sessionId: 'test-session-1', traceId: 'trace-test-1', accountId: 'test-account-1' };
const issue = (until = now + 600_000, key: string | undefined = secret) => issueListeningGrant(binding, 3, key, now, until);
test('签名授权绑定完整会话，来源授权与30分钟边界限制有效期', async () => {
  const grant = await issue();
  const verified = await verifyListeningGrant(grant, binding, secret, now);
  assert.equal(verified?.policyVersion, 3); assert.equal(verified?.expiresAtMs, now + 600_000);
  assert.equal((await verifyListeningGrant(await issue(now + 4_000_000), binding, secret, now))?.expiresAtMs, now + 1_800_000);
});
test('绑定任何一项变化均拒绝，含当前归属变化', async () => {
  const token = await issue();
  for (const [key, value] of Object.entries({ sn: 'BJP00326070803800007', room: binding.room + '1', sessionId: 'other-session', traceId: 'other-trace', accountId: 'new-owner' })) {
    assert.equal(await verifyListeningGrant(token, { ...binding, [key]: value }, secret, now), null, key);
  }
});
test('过期、未来票据、错误签名、空或弱secret均不降级放行', async () => {
  const token = await issue();
  assert.equal(await verifyListeningGrant(token, binding, secret, now + 600_000), null);
  assert.equal(await verifyListeningGrant(token, binding, secret, now - 1000), null);
  for (const key of [undefined, '', 'dev-secret-change-me', secret + 'wrong']) {
    assert.equal(await verifyListeningGrant(token, binding, key, now), null);
  }
  for (const key of [undefined, '', 'dev-secret-change-me']) {
    await assert.rejects(() => issueListeningGrant(binding, 3, key, now, now + 10000));
  }
});
test('非法上下文、授权期限、策略版本不能签票据', async () => {
  for (const bad of [{ ...binding, sn: '03800006' }, { ...binding, traceId: 'bad trace' }, { ...binding, accountId: '' }, { ...binding, room: 'sn-BJP00326070803800007-1800000000' }]) {
    await assert.rejects(() => issueListeningGrant(bad, 3, secret, now, now + 10000));
  }
  for (const until of [now, now - 1, Number.NaN, Number.POSITIVE_INFINITY]) await assert.rejects(() => issue(until));
  for (const version of [0, -1, 1.5]) await assert.rejects(() => issueListeningGrant(binding, version, secret, now, now + 10000));
});
test('不同JWT类型、能力scope和缺少必要字段都拒绝', async () => {
  const payload = { ...binding, policyVersion: 3, scope: 'listening:lease', capability: 'listening_mode_v1' };
  for (const [claims, typ] of [[{ ...payload, scope: 'search' }, 'p003-listening+jwt'],
    [payload, 'JWT'], [{ ...payload, capability: 'other' }, 'p003-listening+jwt'],
    [{ ...payload, traceId: undefined }, 'p003-listening+jwt']] as const) {
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ }).setIssuer('p003-listening')
      .setAudience('p003-worker-listening').setSubject(binding.sn).setJti('test-jti').setIssuedAt(now / 1000)
      .setNotBefore(now / 1000).setExpirationTime(now / 1000 + 10).sign(new TextEncoder().encode(secret));
    assert.equal(await verifyListeningGrant(token, binding, secret, now), null);
  }
  assert.equal(await verifyListeningGrant('garbage', binding, secret, now), null);
});

test('正确签名也不能绕过时长与nbf边界；不复制额外字段', async () => {
  const payload = { ...binding, policyVersion: 3, scope: 'listening:lease', capability: 'listening_mode_v1' };
  for (const [nbf, duration] of [[now / 1000, 1801], [now / 1000 - 1, 10]]) {
    const token = await new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'p003-listening+jwt' })
      .setIssuer('p003-listening').setAudience('p003-worker-listening').setSubject(binding.sn)
      .setJti('test-jti').setIssuedAt(now / 1000).setNotBefore(nbf).setExpirationTime(now / 1000 + duration)
      .sign(new TextEncoder().encode(secret));
    assert.equal(await verifyListeningGrant(token, binding, secret, now), null);
  }
  const context = { ...binding, userTranscript: 'synthetic private text', secret: 'do not copy', scope: 'search' };
  const decoded = decodeJwt(await issueListeningGrant(context, 3, secret, now, now + 10000));
  assert.equal(decoded.userTranscript, undefined); assert.equal(decoded.secret, undefined);
  assert.equal(decoded.scope, 'listening:lease');
});
