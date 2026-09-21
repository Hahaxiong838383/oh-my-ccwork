/**
 * 设备接入管理单测：registry store 的 DB override 语义 + admin devices API + 签发凭据全链路。
 * 跑法：cd apps/server && npx tsx scripts/device-registry.test.ts
 * 零端口：Hono app.request() 内存请求；admin token 走真实 /api/auth/login。
 * 敏感纪律：本文件绝不打印 token；日志拦截后扫描不得出现 eyJ。
 * 核心回归（川哥红线）：env 存量 SN 在 DB 无记录时必须照常放行 —— 真机等价路径。
 */
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';

const DB_PATH = '/private/tmp/claude-501/-Users-rayman-chen-mycc/410a354a-ee50-4c8b-9b06-02a639743e97/scratchpad/test-device-registry.db';
for (const suffix of ['', '-wal', '-shm', '-pairing.db', '-pairing.db-wal', '-pairing.db-shm']) {
  try {
    rmSync(DB_PATH.replace(/\.db$/, '') + (suffix.startsWith('-pairing') ? suffix : '.db' + suffix));
  } catch {
    /* 不存在即干净 */
  }
}

// env 必须在业务模块加载前就位（store 单例在模块顶层建库）
process.env.DEVICES_DB_PATH = DB_PATH;
process.env.PAIRING_DB_PATH = DB_PATH.replace(/\.db$/, '-pairing.db'); // E 段：台账凭据列由 claim 会话回填，需隔离 pairing 库
process.env.AUTH_JWT_SECRET = 'test-auth-secret';
process.env.LIVEKIT_API_KEY = 'voicekey';
process.env.LIVEKIT_API_SECRET = '0123456789abcdef0123456789abcdef';
// SN_ENV 模拟存量真机（只在 env、不进 DB）；SN_DB 模拟运营台增量设备（只进 DB、不在 env）
process.env.DEVICE_SN_ALLOW = 'BJP00326060100200003';
process.env.DEVICE_SESSION_RPM = '1000';
process.env.STUDIO_USER = 'test-admin';
process.env.STUDIO_PASS = 'test-pass';

const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { deviceSessionRoute } = await import('../src/routes/device-session.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { pairingStore, hashToken } = await import('../src/pairing-store.js');
const { authRoute } = await import('../src/routes/auth.js');
const { SignJWT, jwtVerify, decodeJwt } = await import('jose');

const SN_ENV = 'BJP00326060100200003';
const SN_DB = 'BJP00326060100200007';

// ── 拦截路由日志做敏感扫描 ──
const logLines: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  logLines.push(a.map(String).join(' '));
};

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);
app.route('/v1/device', deviceSessionRoute);

const enc = new TextEncoder().encode('test-auth-secret');
async function deviceCred(sn: string): Promise<string> {
  return new SignJWT({ kind: 'p003-device' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sn)
    .setExpirationTime('1h')
    .sign(enc);
}
async function callSession(cred: string, sn: string): Promise<Response> {
  return app.request('/v1/device/session', {
    method: 'POST',
    headers: { authorization: `Bearer ${cred}`, 'content-type': 'application/json' },
    body: JSON.stringify({ device_sn: sn, trace_id: `trace-${sn}` }),
  });
}
async function adminReq(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(`/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

// ── 登录拿 admin / guest token ──
const adminLogin = await app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'test-admin', password: 'test-pass' }),
});
const adminToken = ((await adminLogin.json()) as { token: string }).token;
const guestLogin = await app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'guest', password: '123456' }),
});
const guestToken = ((await guestLogin.json()) as { token: string }).token;
assert.ok(adminToken && guestToken, '登录失败，无法继续');

const credEnv = await deviceCred(SN_ENV);
const credDb = await deviceCred(SN_DB);

// ═══ A. DB override 白名单语义（核心回归） ═══

await t('A1 存量真机路径：env 有 + DB 无记录 → session 200', async () => {
  const r = await callSession(credEnv, SN_ENV);
  assert.equal(r.status, 200);
});

await t('A2 纯 DB 增量设备：env 无 + DB active → 200', async () => {
  deviceRegistryStore.add(SN_DB, '测试增量设备');
  const r = await callSession(credDb, SN_DB);
  assert.equal(r.status, 200);
});

await t('A3 DB disabled 压制 env 存量 → 403', async () => {
  deviceRegistryStore.add(SN_ENV, '临时压制测试');
  deviceRegistryStore.setStatus(SN_ENV, 'disabled');
  const r = await callSession(credEnv, SN_ENV);
  assert.equal(r.status, 403);
});

await t('A4 删除 DB 记录 → env 存量恢复放行（转移可逆）', async () => {
  deviceRegistryStore.remove(SN_ENV);
  const r = await callSession(credEnv, SN_ENV);
  assert.equal(r.status, 200);
});

await t('A5 DB disabled 的增量设备 → 403，恢复 active → 200', async () => {
  deviceRegistryStore.setStatus(SN_DB, 'disabled');
  assert.equal((await callSession(credDb, SN_DB)).status, 403);
  deviceRegistryStore.setStatus(SN_DB, 'active');
  assert.equal((await callSession(credDb, SN_DB)).status, 200);
});

// ═══ B. 流水落库 ═══

await t('B1 ok 流水字段齐且含 room/trace', async () => {
  const rows = deviceRegistryStore.listSessions(SN_DB, 10);
  const okRow = rows.find((r) => r.status === 'ok');
  assert.ok(okRow, '无 ok 流水');
  assert.match(okRow!.room, new RegExp(`^sn-${SN_DB}-\\d+$`));
  assert.equal(okRow!.trace_id, `trace-${SN_DB}`);
  assert.ok(okRow!.ttl_s > 0 && okRow!.created_at > 0);
});

await t('B2 403 拒绝也有流水（rejected_403）', async () => {
  const rows = deviceRegistryStore.listSessions(SN_DB, 20);
  assert.ok(rows.some((r) => r.status === 'rejected_403'), '无 rejected_403 流水');
});

await t('B3 流水任何字段不含 JWT（敏感扫描）', async () => {
  const rows = deviceRegistryStore.listSessions(undefined, 200);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes('eyJ'), '流水中出现疑似 JWT');
});

// ═══ C. admin API 权限与 CRUD ═══

await t('C1 guest 访问 /devices → 403 forbidden_devices（GET 也拒）', async () => {
  const r = await adminReq(guestToken, 'GET', '/devices');
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, 'forbidden_devices');
});

await t('C2 无 token → 401', async () => {
  const r = await app.request('/api/admin/devices', { method: 'GET' });
  assert.equal(r.status, 401);
});

await t('C3 admin GET /devices：台账 + env_allow + stats 齐', async () => {
  const r = await adminReq(adminToken, 'GET', '/devices');
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.ok(Array.isArray(j.devices) && j.devices.some((d: any) => d.sn === SN_DB));
  assert.deepEqual(j.env_allow, [SN_ENV]);
  assert.ok(typeof j.stats.today_ok === 'number' && typeof j.stats.today_rejected === 'number');
  const dev = j.devices.find((d: any) => d.sn === SN_DB);
  assert.ok(dev.last_active_at > 0 && dev.session_count >= 2, '活跃聚合缺失');
});

await t('C4 POST /devices 非法 SN → 400；重复 → 409；小写自动归一', async () => {
  assert.equal((await adminReq(adminToken, 'POST', '/devices', { sn: 'ABC123' })).status, 400);
  assert.equal((await adminReq(adminToken, 'POST', '/devices', { sn: SN_DB })).status, 409);
  const r = await adminReq(adminToken, 'POST', '/devices', {
    sn: 'bjp00326060100200009',
    note: '小写输入',
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).device.sn, 'BJP00326060100200009');
});

await t('C5 PATCH 状态与备注；非法状态 400；不存在 404', async () => {
  const r = await adminReq(adminToken, 'PATCH', `/devices/${SN_DB}`, { note: '改备注', status: 'disabled' });
  assert.equal(r.status, 200);
  const dev = ((await r.json()) as any).device;
  assert.equal(dev.status, 'disabled');
  assert.equal(dev.note, '改备注');
  assert.equal((await adminReq(adminToken, 'PATCH', `/devices/${SN_DB}`, { status: 'nope' })).status, 400);
  assert.equal((await adminReq(adminToken, 'PATCH', '/devices/BJP00326060100299999', { note: 'x' })).status, 404);
  await adminReq(adminToken, 'PATCH', `/devices/${SN_DB}`, { status: 'active' });
});

// ═══ D. 签发凭据全链路 ═══

await t('D1 签发凭据：claims 正确且能真实换 session（全链路）', async () => {
  const r = await adminReq(adminToken, 'POST', `/devices/${SN_DB}/credential`, { days: 30 });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.ok(j.token && j.expires_at_ms > Date.now());
  // claims 与手工脚本 sign-device-credential.ts 同参
  const { payload } = await jwtVerify(j.token, enc);
  assert.equal(payload.kind, 'p003-device');
  assert.equal(payload.sub, SN_DB);
  assert.equal((payload.exp as number) * 1000, j.expires_at_ms);
  // 全链路：新凭据实际能换 session
  const s = await callSession(j.token, SN_DB);
  assert.equal(s.status, 200);
  // DB 记录了到期时间（不含原文）
  const dev = deviceRegistryStore.get(SN_DB)!;
  assert.equal(dev.credential_expires_at, j.expires_at_ms);
});

await t('D2 days 越界 400；停用设备拒签 400；不存在 404', async () => {
  assert.equal(
    (await adminReq(adminToken, 'POST', `/devices/${SN_DB}/credential`, { days: 0 })).status,
    400,
  );
  assert.equal(
    (await adminReq(adminToken, 'POST', `/devices/${SN_DB}/credential`, { days: 999 })).status,
    400,
  );
  await adminReq(adminToken, 'PATCH', `/devices/${SN_DB}`, { status: 'disabled' });
  assert.equal(
    (await adminReq(adminToken, 'POST', `/devices/${SN_DB}/credential`, { days: 30 })).status,
    400,
  );
  await adminReq(adminToken, 'PATCH', `/devices/${SN_DB}`, { status: 'active' });
  assert.equal(
    (await adminReq(adminToken, 'POST', '/devices/BJP00326060100299999/credential', { days: 30 }))
      .status,
    404,
  );
});

await t('D3 guest 签发凭据 → 403', async () => {
  const r = await adminReq(guestToken, 'POST', `/devices/${SN_DB}/credential`, { days: 30 });
  assert.equal(r.status, 403);
});

// ═══ E. 流水查询 API + 删除 ═══

await t('E1 GET /device-sessions 按 SN 过滤 + limit 生效', async () => {
  const r = await adminReq(adminToken, 'GET', `/device-sessions?sn=${SN_DB}&limit=3`);
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.ok(j.sessions.length <= 3);
  assert.ok(j.sessions.every((s: any) => s.sn === SN_DB));
});

await t('E2 DELETE 台账后流水保留', async () => {
  assert.equal((await adminReq(adminToken, 'DELETE', '/devices/BJP00326060100200009')).status, 200);
  assert.equal((await adminReq(adminToken, 'DELETE', '/devices/BJP00326060100200009')).status, 404);
  const rows = deviceRegistryStore.listSessions(SN_DB, 5);
  assert.ok(rows.length > 0, '流水被误删');
});

await t('E3 流水行备注：PATCH 保存 + GET 回读；非法 id 400；不存在 404', async () => {
  const first = deviceRegistryStore.listSessions(undefined, 1, 0)[0];
  const r = await adminReq(adminToken, 'PATCH', `/device-sessions/${first.id}`, { note: '小明在测打断' });
  assert.equal(r.status, 200);
  const back = deviceRegistryStore.listSessions(undefined, 5, 0).find((s) => s.id === first.id);
  assert.equal(back!.note, '小明在测打断');
  assert.equal((await adminReq(adminToken, 'PATCH', '/device-sessions/abc', { note: 'x' })).status, 400);
  assert.equal((await adminReq(adminToken, 'PATCH', '/device-sessions/999999', { note: 'x' })).status, 404);
});

await t('E4 分页：total 恒定 + offset 翻页不重叠不遗漏', async () => {
  const r1 = await adminReq(adminToken, 'GET', '/device-sessions?limit=2&offset=0');
  const j1 = (await r1.json()) as Record<string, any>;
  const r2 = await adminReq(adminToken, 'GET', '/device-sessions?limit=2&offset=2');
  const j2 = (await r2.json()) as Record<string, any>;
  assert.ok(j1.total >= 4, `流水不足 4 条(${j1.total})，前置用例产出异常`);
  assert.equal(j1.total, j2.total);
  assert.equal(j1.sessions.length, 2);
  const ids1 = j1.sessions.map((s: any) => s.id);
  const ids2 = j2.sessions.map((s: any) => s.id);
  assert.ok(ids1.every((id: number) => !ids2.includes(id)), '两页出现重叠 id');
  const all = (await (await adminReq(adminToken, 'GET', `/device-sessions?limit=${j1.total}`)).json()) as Record<string, any>;
  assert.equal(all.sessions.length, j1.total, 'limit=total 拉全量数量不符');
});

// ═══ G. 台账「凭据」列读侧回填（2026-09-06）：配网 claim 签发只进 ECIES 载荷、不写 registry.credential_* ═══

await t('G1 有 claim 会话、台账无签发记录 → credential_source=pairing_claim，到期=claimed_at 取整秒+365d', async () => {
  const SN_P = 'BJP00326060100200011';
  assert.equal((await adminReq(adminToken, 'POST', '/devices', { sn: SN_P, note: '配网签发回填' })).status, 200);
  const nonce = 'e1-nonce-' + 'x'.repeat(24);
  pairingStore.confirmSessionByHash('acct-e1', SN_P, hashToken(nonce), 'AgEBAQEB', 'admin');
  pairingStore.markSessionClaimed(nonce, 'ready');
  const claimedAt = pairingStore.lastClaimedSessionBySn(SN_P)!.claimed_at!;
  const dev = ((await (await adminReq(adminToken, 'GET', '/devices')).json()) as any).devices.find((d: any) => d.sn === SN_P);
  assert.equal(dev.credential_source, 'pairing_claim');
  assert.equal(dev.credential_issued_at, Math.floor(claimedAt / 1000) * 1000);
  assert.equal(dev.credential_expires_at, Math.floor(claimedAt / 1000) * 1000 + 365 * 86_400_000);
});

await t('G2 台账手工签发后台账优先 credential_source=registry；未 claim 未签发 → null', async () => {
  const SN_P = 'BJP00326060100200011';
  const SN_BARE = 'BJP00326060100200012';
  assert.equal((await adminReq(adminToken, 'POST', '/devices', { sn: SN_BARE, note: '未 claim 未签发' })).status, 200);
  const issued = (await (await adminReq(adminToken, 'POST', `/devices/${SN_P}/credential`, { days: 30 })).json()) as any;
  const list = ((await (await adminReq(adminToken, 'GET', '/devices')).json()) as any).devices;
  const dev = list.find((d: any) => d.sn === SN_P);
  assert.equal(dev.credential_source, 'registry');
  assert.equal(dev.credential_expires_at, issued.expires_at_ms);
  const bare = list.find((d: any) => d.sn === SN_BARE);
  assert.equal(bare.credential_source, null);
  assert.equal(bare.credential_expires_at, null);
});

// ═══ F. 日志敏感扫描 ═══

// ═══ G. 删除 = 作废旧凭据（2026-09-16 川哥：删了就是新设备，必须重新签发/认领） ═══

const SN_REV = 'BJP00326060100200031'; // 本文件其它段未用过的 SN（200003/007/009/011/012 已占）
let revToken1 = '';
let revToken2 = '';

await t('G1 添加 + 签发 → 凭据可用（前置正锚）', async () => {
  assert.equal((await adminReq(adminToken, 'POST', '/devices', { sn: SN_REV, note: '作废测试机' })).status, 200);
  const r = await adminReq(adminToken, 'POST', `/devices/${SN_REV}/credential`, { days: 30 });
  assert.equal(r.status, 200);
  revToken1 = ((await r.json()) as { token: string }).token;
  assert.ok(revToken1 && !logLines.join('\n').includes(revToken1), '签发失败或 token 进了日志');
  assert.equal((await callSession(revToken1, SN_REV)).status, 200);
});

await t('G2 DELETE 后：旧凭据 401、无 iat 老 token 也 401，响应带作废水位', async () => {
  const r = await adminReq(adminToken, 'DELETE', `/devices/${SN_REV}`);
  assert.equal(r.status, 200);
  const j = (await r.json()) as { credentials_revoked_before_ms?: number };
  assert.ok(typeof j.credentials_revoked_before_ms === 'number' && j.credentials_revoked_before_ms > 0, '响应缺作废水位');
  assert.equal((await callSession(revToken1, SN_REV)).status, 401, '旧凭据仍被放行');
  assert.equal((await callSession(await deviceCred(SN_REV), SN_REV)).status, 401, '无 iat 老 token 仍被放行');
});

await t('G3 重新添加 = 新设备：旧凭据仍 401，重新签发的新凭据 200', async () => {
  assert.equal((await adminReq(adminToken, 'POST', '/devices', { sn: SN_REV, note: '重加' })).status, 200);
  assert.equal((await callSession(revToken1, SN_REV)).status, 401, '重加后旧凭据复活');
  // 水位含删除当秒（iat 秒精度）：新凭据必须签在下一秒起，等 1.1 s 再签（真实操作里删除→重签总隔着人手几秒）
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const r = await adminReq(adminToken, 'POST', `/devices/${SN_REV}/credential`, { days: 30 });
  assert.equal(r.status, 200);
  revToken2 = ((await r.json()) as { token: string }).token;
  assert.notEqual(revToken2, revToken1);
  assert.equal((await callSession(revToken2, SN_REV)).status, 200, '新签凭据被误拒（水位秒级比对出错）');
});

await t('G4 负锚：从未删除过的设备，无 iat token 照常放行（存量真机不受影响）', async () => {
  assert.equal(deviceRegistryStore.credentialNotBeforeSec(SN_DB), null);
  assert.equal((await callSession(credDb, SN_DB)).status, 200);
});

await t('G5 删除审计日志命中且不含 JWT', async () => {
  assert.ok(
    logLines.some((l) => l.includes('[admin-devices] device removed') && l.includes(`sn=${SN_REV}`) && l.includes('credentials revoked before=')),
    '删除审计日志缺失',
  );
});

await t('F1 路由日志无 JWT + 签发审计正锚命中', async () => {
  const all = logLines.join('\n');
  assert.ok(!all.includes('eyJ'), '日志出现疑似 JWT');
  assert.ok(
    logLines.some((l) => l.includes('[admin-devices] credential issued') && l.includes(`sn=${SN_DB}`)),
    '签发审计日志缺失',
  );
  assert.ok(
    logLines.some((l) => l.includes('[device-session] ok')),
    '正锚缺失：session ok 日志',
  );
});

console.log = origLog;
origLog(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
