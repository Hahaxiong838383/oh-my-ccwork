/**
 * 设备 Session API 单测（S2B1 合同 P0-C 的 11 项）。
 * 跑法：cd apps/server && npx tsx scripts/device-session.test.ts
 * 零端口：用 Hono app.request() 内存请求。
 * 敏感纪律：本文件绝不打印 token；路由日志被拦截后做敏感扫描（无 eyJ… + 正锚必须命中）。
 */
import assert from 'node:assert';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

// env 必须在业务模块加载前就位（虽然路由是请求时读 env，这里仍统一先设，杜绝顺序坑）
process.env.AUTH_JWT_SECRET = 'test-auth-secret';
process.env.LIVEKIT_API_KEY = 'voicekey';
process.env.LIVEKIT_API_SECRET = '0123456789abcdef0123456789abcdef';
process.env.DEVICE_SN_ALLOW = 'BJP00326060100200003,BJP00326060100200005';
process.env.DEVICE_SESSION_RPM = '100';

const { deviceSessionRoute, assertTokenMatchesResponse } = await import(
  '../src/routes/device-session.js'
);
const { validateDeviceSn } = await import('../src/device-sn.js');
const { decodeJwt } = await import('jose');

// ── 拦截路由日志：既做敏感扫描，也当正锚 ──
const logLines: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  logLines.push(a.map(String).join(' '));
};

const app = new Hono();
app.route('/v1/device', deviceSessionRoute);

const SN = 'BJP00326060100200003';
const SN2 = 'BJP00326060100200005';
const enc = new TextEncoder().encode('test-auth-secret');
async function deviceCred(sn: string): Promise<string> {
  return new SignJWT({ kind: 'p003-device' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sn)
    .setExpirationTime('1h')
    .sign(enc);
}
async function callSession(opts: {
  cred?: string;
  sn?: string;
  trace?: string;
  raw?: string;
}): Promise<Response> {
  return app.request('/v1/device/session', {
    method: 'POST',
    headers: {
      ...(opts.cred ? { authorization: `Bearer ${opts.cred}` } : {}),
      'content-type': 'application/json',
    },
    body:
      opts.raw ??
      JSON.stringify({
        device_sn: opts.sn ?? SN,
        trace_id: opts.trace ?? 'trace-test-1',
        app_version: '1.2.2-canary.2',
        firmware_version: 'unknown',
      }),
  });
}

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    pass++;
    origLog(`  ok  ${name}`);
  } catch (e) {
    fail++;
    origLog(`  FAIL ${name}: ${(e as Error).message}`);
  }
}

const cred = await deviceCred(SN);

// 1. 合法 SN → 200，且响应字段齐、token claims 与响应一致（= 测试 8 的正向半）
await t('合法 SN 返回 200 且 claims 与响应一致', async () => {
  const r = await callSession({ cred });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.status, 'ok');
  assert.equal(j.identity, `dev-${SN}`);
  assert.match(j.room_name, new RegExp(`^sn-${SN}-\\d+$`));
  assert.equal(j.expected_agent_name, 'rust-worker');
  assert.equal(j.trace_id, 'trace-test-1');
  assert.ok(j.session_id && j.expires_at_ms > Date.now());
  assertTokenMatchesResponse(j.token, j); // 不 throw 即一致
  const c = decodeJwt(j.token) as Record<string, any>;
  assert.equal(c.iss, 'voicekey');
  assert.equal(c.video.roomJoin, true);
});

// 2. ADB serial → 400（身份红线）
await t('ADB serial 返回 400', async () => {
  const r = await callSession({ cred, sn: 'D160X65140100098' });
  assert.equal(r.status, 400);
});

// 3. 协议无效值 → 400
await t('BJ000000000000000000 返回 400', async () => {
  const r = await callSession({ cred, sn: 'BJ000000000000000000' });
  assert.equal(r.status, 400);
});

// 4. 非法日期 → 400
await t('非法日期 BJP00326023100000001 返回 400', async () => {
  const r = await callSession({ cred, sn: 'BJP00326023100000001' });
  assert.equal(r.status, 400);
});

// 5. 全零流水号 → 400
await t('流水号 00000000 返回 400', async () => {
  const r = await callSession({ cred, sn: 'BJP00326060100000000' });
  assert.equal(r.status, 400);
});

// SN 校验器负向锚：确认它不是恒绿（合法值必须真的过）
await t('validateDeviceSn 正/负锚', () => {
  assert.equal(validateDeviceSn(SN).ok, true);
  assert.equal(validateDeviceSn('BJP00399023100000001').ok, false);
});

// 6. 缺鉴权 → 401
await t('缺鉴权返回 401', async () => {
  const r = await callSession({});
  assert.equal(r.status, 401);
});

// 7. SN 与凭据不匹配 → 403
await t('SN 与凭据不匹配返回 403', async () => {
  const other = await deviceCred(SN2);
  const r = await callSession({ cred: other, sn: SN });
  assert.equal(r.status, 403);
});

// 7b. 合法格式但不在白名单 → 403（fail-closed）
await t('白名单外 SN 返回 403', async () => {
  const outsider = 'BJP00326060100200099';
  const r = await callSession({ cred: await deviceCred(outsider), sn: outsider });
  assert.equal(r.status, 403);
});

// 8（负向半）. 自检函数必须能抓到错 token——伪造一个 room 不符的
await t('自检函数对坏 token 必须 throw', async () => {
  const badToken = await new SignJWT({
    video: { room: 'sn-WRONG-1', roomJoin: true },
    roomConfig: { agents: [{ agentName: 'rust-worker' }] },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('voicekey')
    .setSubject(`dev-${SN}`)
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
  assert.throws(() =>
    assertTokenMatchesResponse(badToken, {
      identity: `dev-${SN}`,
      room_name: `sn-${SN}-1`,
      expires_at_ms: Date.now() + 3600_000,
    }),
  );
});

// 9. 两次请求 → session_id 与 room 均不同（同秒靠逻辑秒递增）
await t('两次 session 的 session_id 与 room 均不同', async () => {
  const a = (await (await callSession({ cred, trace: 't-a' })).json()) as Record<string, any>;
  const b = (await (await callSession({ cred, trace: 't-b' })).json()) as Record<string, any>;
  assert.notEqual(a.session_id, b.session_id);
  assert.notEqual(a.room_name, b.room_name);
});

// 10. prefetch 不产 token
await t('prefetch 返回 warming 且无 token', async () => {
  const r = await app.request('/v1/device/session/prefetch', {
    method: 'POST',
    headers: { authorization: `Bearer ${cred}` },
  });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.status, 'warming');
  assert.ok(j.prefetch_id && j.expires_at_ms > Date.now());
  assert.equal('token' in j, false);
});

// 429：独立 SN + 收紧 RPM（不影响其他用例的额度）
await t('超频返回 429', async () => {
  process.env.DEVICE_SESSION_RPM = '2';
  const c2 = await deviceCred(SN2);
  const r1 = await callSession({ cred: c2, sn: SN2, trace: 'r1' });
  const r2 = await callSession({ cred: c2, sn: SN2, trace: 'r2' });
  const r3 = await callSession({ cred: c2, sn: SN2, trace: 'r3' });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  process.env.DEVICE_SESSION_RPM = '100';
});

// 503：签发凭据缺失
await t('LiveKit 凭据未配返回 503', async () => {
  const saved = process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_API_SECRET;
  const r = await callSession({ cred, trace: 't-503' });
  assert.equal(r.status, 503);
  process.env.LIVEKIT_API_SECRET = saved;
});

// 请求体不是 JSON → 400
await t('坏 JSON 返回 400', async () => {
  const r = await callSession({ cred, raw: '{not json' });
  assert.equal(r.status, 400);
});

// 11. 敏感扫描：路由日志无 JWT；正锚 = ok 行必须存在（证明扫描对象非空）
await t('日志敏感扫描（含正锚）', () => {
  assert.ok(
    logLines.some((l) => l.includes('[device-session] ok')),
    '正锚缺失：没有任何 ok 日志，扫描对象为空',
  );
  const leaked = logLines.filter((l) => /eyJ[A-Za-z0-9_-]{10,}/.test(l));
  assert.equal(leaked.length, 0, `日志泄露疑似 JWT ${leaked.length} 行`);
});

console.log = origLog;
origLog(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
