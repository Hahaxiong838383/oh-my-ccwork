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
  supports?: string[];
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
        ...(opts.supports ? { supports: opts.supports } : {}),
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

// 8c. input_ready 合同（2026-08-18 冻结）：agents[0].metadata 携带 activeTraceId+session_id
await t('token agents metadata 携带 trace_id 与 session_id', async () => {
  const r = await callSession({ cred, trace: 'trace-meta-1' });
  const j = (await r.json()) as Record<string, any>;
  const c = decodeJwt(j.token) as Record<string, any>;
  const meta = JSON.parse(c.roomConfig.agents[0].metadata);
  assert.equal(meta.trace_id, 'trace-meta-1');
  assert.equal(meta.session_id, j.session_id);
});

// 8d. 负向锚：metadata trace 与响应不符时自检必须 throw（证明新分支不恒绿）
await t('自检函数对 metadata trace 不符必须 throw', async () => {
  const roomName = `sn-${SN}-1`;
  const badToken = await new SignJWT({
    video: { room: roomName, roomJoin: true },
    roomConfig: {
      agents: [{ agentName: 'rust-worker', metadata: JSON.stringify({ trace_id: 'other' }) }],
    },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('voicekey')
    .setSubject(`dev-${SN}`)
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
  assert.throws(
    () =>
      assertTokenMatchesResponse(badToken, {
        identity: `dev-${SN}`,
        room_name: roomName,
        expires_at_ms: Date.now() + 3600_000,
        trace_id: 'trace-meta-2',
      }),
    /metadata trace_id/,
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

const FT_AGENT = 'rust-worker-firstturn'; // B29 单机灰度定向派单目标（测试值）
const OLD_AGENT = 'rust-worker';

// ── B23 产品首句 v1 签发协商（2026-09-11）：名单 ∧ 声明 才签；任一不成立 = 旧路径；contract 与 metadata 同源 ──
await t('B23 名单内且声明 → 签 contract，metadata 三字段同源', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN;
  process.env.ONESHOT_FIRST_TURN_AGENT_NAME = FT_AGENT;
  try {
    const r = await callSession({ cred, supports: ['oneshot_first_turn_v1', 'local_receipt_v1'] });
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, any>;
    assert.deepEqual(j.contract, {
      input_mode: 'ordered_pcm',
      oneshot_first_turn: 'v1',
      local_receipt: 'v1',
      history_topic: 'p003.audio.history.v1',
      worker_capabilities: ['android_local_receipt_v1', 'oneshot_first_turn_v1'],
    });
    assertTokenMatchesResponse(j.token, j);
    const c = decodeJwt(j.token) as Record<string, any>;
    const meta = JSON.parse(c.roomConfig.agents[0].metadata);
    assert.equal(meta.input_mode, 'ordered_pcm');
    assert.equal(meta.oneshot_first_turn, 'v1');
    assert.equal(meta.local_receipt, 'v1');
    assert.equal(meta.trace_id, 'trace-test-1');
    assert.equal(meta.session_id, j.session_id);
    assert.ok(logLines.some((l) => l.includes('contract=first_turn_v1')));
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
});

await t('B23 名单内但客户端未声明（v261 老客户端）→ 旧路径，metadata 无三键', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN;
  try {
    const r = await callSession({ cred });
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, any>;
    assert.equal(j.contract, null);
    assertTokenMatchesResponse(j.token, j);
    const meta = JSON.parse((decodeJwt(j.token) as Record<string, any>).roomConfig.agents[0].metadata);
    for (const k of ['input_mode', 'oneshot_first_turn', 'local_receipt']) assert.ok(!(k in meta), k);
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
});

await t('B23 声明了但不在名单 / 名单为空 → 旧路径', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN2;
  try {
    const r = await callSession({ cred, supports: ['oneshot_first_turn_v1'] });
    const j = (await r.json()) as Record<string, any>;
    assert.equal(j.contract, null);
    assertTokenMatchesResponse(j.token, j);
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
  const r2 = await callSession({ cred, supports: ['oneshot_first_turn_v1'] });
  const j2 = (await r2.json()) as Record<string, any>;
  assert.equal(j2.contract, null);
});

await t('B23 supports 畸形值被忽略，不影响签发', async () => {
  const r = await callSession({ cred, raw: JSON.stringify({ device_sn: SN, trace_id: 'trace-test-2', supports: 'oneshot_first_turn_v1' }) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.contract, null);
});

await t('B23 自检：contract 与 metadata 不同源必 throw（负锚）', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN;
  process.env.ONESHOT_FIRST_TURN_AGENT_NAME = FT_AGENT;
  try {
    const r = await callSession({ cred, supports: ['oneshot_first_turn_v1'] });
    const j = (await r.json()) as Record<string, any>;
    assert.throws(() => assertTokenMatchesResponse(j.token, { ...j, contract: null }), /旧路径 metadata 不得含/);
    assert.throws(
      () => assertTokenMatchesResponse(j.token, { ...j, contract: { ...j.contract, local_receipt: 'v2' } }),
      /metadata\.local_receipt/,
    );
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
});

// ── B29 单机灰度定向派单（2026-09-11）：签了新合同必须同时把房派给专用 agent；
//    缺派单目标 = 拒签新能力退回旧路径，绝不把 ordered 首句投给没有代次状态机的旧 worker ──
await t('B29 ①目标 SN + supports + 有派单目标 → v1 合同 ∧ 派给新 agent（响应/JWT/自检三处同值）', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN;
  process.env.ONESHOT_FIRST_TURN_AGENT_NAME = FT_AGENT;
  try {
    const r = await callSession({ cred, supports: ['oneshot_first_turn_v1', 'local_receipt_v1'] });
    const j = (await r.json()) as Record<string, any>;
    assert.ok(j.contract, 'contract 应非空');
    assert.equal(j.expected_agent_name, FT_AGENT, '响应 expected_agent_name');
    const c = decodeJwt(j.token) as Record<string, any>;
    assert.equal(c.roomConfig.agents.length, 1);
    assert.equal(c.roomConfig.agents[0].agentName, FT_AGENT, 'JWT roomConfig.agents[0].agentName');
    assertTokenMatchesResponse(j.token, j); // 自检用的是响应里的名字，不是常量
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
});

await t('B29 ②同 SN 无 supports → contract null ∧ 仍派旧 agent', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN;
  process.env.ONESHOT_FIRST_TURN_AGENT_NAME = FT_AGENT;
  try {
    const j = (await (await callSession({ cred })).json()) as Record<string, any>;
    assert.equal(j.contract, null);
    assert.equal(j.expected_agent_name, OLD_AGENT);
    assert.equal((decodeJwt(j.token) as any).roomConfig.agents[0].agentName, OLD_AGENT);
    assertTokenMatchesResponse(j.token, j);
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
});

await t('B29 ③非名单合法 SN + supports → contract null ∧ 仍派旧 agent', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN2;
  process.env.ONESHOT_FIRST_TURN_AGENT_NAME = FT_AGENT;
  try {
    const j = (await (await callSession({ cred, supports: ['oneshot_first_turn_v1'] })).json()) as Record<string, any>;
    assert.equal(j.contract, null);
    assert.equal(j.expected_agent_name, OLD_AGENT);
    assert.equal((decodeJwt(j.token) as any).roomConfig.agents[0].agentName, OLD_AGENT);
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
});

await t('B29 ④fail-closed：名单内 + supports 但未配派单目标 → 拒签新能力，退回旧路径旧 agent', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN;
  delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME; // 就是要它缺席
  try {
    const j = (await (await callSession({ cred, supports: ['oneshot_first_turn_v1', 'local_receipt_v1'] })).json()) as Record<string, any>;
    assert.equal(j.contract, null, '缺派单目标时绝不能签出 contract');
    assert.equal(j.expected_agent_name, OLD_AGENT);
    const meta = JSON.parse((decodeJwt(j.token) as any).roomConfig.agents[0].metadata);
    for (const k of ['input_mode', 'oneshot_first_turn', 'local_receipt'])
      assert.ok(!(k in meta), `旧路径 metadata 不得含 ${k}`);
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
  }
});

await t('B29 负锚：响应 expected_agent_name 与 JWT 不符必 throw（证明自检真在对撞而非恒绿）', async () => {
  process.env.ONESHOT_FIRST_TURN_SN_ALLOW = SN;
  process.env.ONESHOT_FIRST_TURN_AGENT_NAME = FT_AGENT;
  try {
    const j = (await (await callSession({ cred, supports: ['oneshot_first_turn_v1'] })).json()) as Record<string, any>;
    assertTokenMatchesResponse(j.token, j); // 正锚：原样必过
    assert.throws(
      () => assertTokenMatchesResponse(j.token, { ...j, expected_agent_name: OLD_AGENT }),
      /expected_agent_name/,
      '把响应的 agent 名改成旧的，自检必须翻红',
    );
  } finally {
    delete process.env.ONESHOT_FIRST_TURN_SN_ALLOW;
    delete process.env.ONESHOT_FIRST_TURN_AGENT_NAME;
  }
});

console.log = origLog;
origLog(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
