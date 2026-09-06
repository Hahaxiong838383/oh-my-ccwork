/**
 * 配网即绑定回归测试 · 跑法：npm run test:pairing（tsx 直跑，无框架）
 *
 * 覆盖（联调合同 v3 §3 + 三项口径确认回执逐条对应）：
 *  - token 签发：家长鉴权 401 / 形状 / 同家长旧未用作废（旧 token_id 轮询 404）
 *  - status：pending → claim 后 bound + sn 回显 / 他人 token 404 / 过期 expired
 *  - claim 幂等矩阵全七行：首次 200(false) / 同 token 同 SN 窗内 200(true 且带可验凭据) /
 *    同 token 异 SN 401 token_used / 超 15min 恢复窗 401 token_used /
 *    未 claim 过期 401 token_expired / 乱 token 401 token_invalid /
 *    台账外 403 / 已绑他人 409 / 同家长新 token 已绑同 SN 200 idempotent=true
 *  - 凭据可用性：jwtVerify 解出 kind=p003-device + sub=SN + exp≈365d，
 *    且 verifyDeviceCredential（三通道共用的验签函数）真放行
 *  - 绑定副作用：parent_account_id 落台账 + brain 账号 device-<SN> 建立（确定性 id）
 *  - 限流 429；SN 格式门 400；响应体不回显 bind_token
 *
 * v2（nonce 桥 + ECIES，codex 开工 prompt 2026-08-22）：
 *  - confirm：pk 严格验证（33B/前缀/曲线上）/ 非法点拒 / 三元组固定 / 同 SN 旧会话作废
 *  - claim v2：pairing_pending(404) / 幂等恢复(密文不同明文等价) / nonce_used(409) /
 *    nonce_expired(410) / SN 不匹配按 pending / 已绑他人 409 / 台账外 403
 *  - ECIES 端到端：设备侧参考解密对撞 / AAD 错 SN 必败 / nonce 错一字节必败
 *  - v1 开关：默认关（404）/ 开着时 v1 全链可用（回滚锚活性）
 *  - 容量向量（2026-09-06 v234 增量）：claim SN30/IP120 下两台同 IP 各 14 claim + announce 零 429；SN 31/IP 121 次 429；桶独立
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'pairing-test-'));
process.env.PAIRING_DB_PATH = join(tmp, 'pairing.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');
process.env.AUTH_JWT_SECRET = 'test-secret'; // 必须先于任何 import（auth-jwt SECRET 模块顶层快照）
process.env.PAIRING_CLAIM_RPM_SN = '100';
process.env.PAIRING_PROTOCOL_V1_ENABLED = '1'; // v1 测试段保回滚锚活性；v2 段末尾切回默认关验开关
process.env.PAIRING_CLAIM_RPM_IP = '1000';

const { Hono } = await import('hono');
const { SignJWT, decodeJwt } = await import('jose');
const { DatabaseSync } = await import('node:sqlite');
const { parentPairingRoute, devicePairingRoute } = await import('../src/routes/pairing.js');
const { verifyDeviceCredential } = await import('../src/routes/device-session.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { decryptCredential, b64url } = await import('../src/pairing-crypto.js');
const { hashToken, credentialWindowFromClaim } = await import('../src/pairing-store.js');
const { createECDH, randomBytes: rndBytes } = await import('node:crypto');
const { accountStore } = await import('../src/account-store.js');

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${g} want=${w}`);
  }
}

const app = new Hono();
app.route('/api/parent/pairing', parentPairingRoute);
app.route('/v1/device/pairing', devicePairingRoute);

const SECRET = new TextEncoder().encode('test-secret');
async function parentJwt(accountId: string): Promise<string> {
  return new SignJWT({ accountId, role: 'parent' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('p003')
    .setAudience('kidshub')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SECRET);
}

async function issueToken(jwt: string) {
  const res = await app.request('/api/parent/pairing/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}` },
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function pollStatus(jwt: string, tokenId: string) {
  const res = await app.request(`/api/parent/pairing/status?token_id=${tokenId}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function claim(sn: string, bindToken: string, fw = 69) {
  const res = await app.request('/v1/device/pairing/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sn, bind_token: bindToken, fw_version_code: fw }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

// 直接开同一 pairing.db 操控时间字段（过期/超窗场景不能真等）
const rawDb = new DatabaseSync(process.env.PAIRING_DB_PATH!);
function ageToken(field: 'expires_at' | 'claimed_at', tokenId: string, deltaMs: number): void {
  rawDb.prepare(`UPDATE pairing_token SET ${field} = ${field} - ? WHERE token_id = ?`).run(deltaMs, tokenId);
}
function ageV2(field: 'expires_at' | 'claimed_at', nonceString: string, deltaMs: number): void {
  rawDb.prepare(`UPDATE pairing_session SET ${field} = ${field} - ? WHERE nonce_hash = ?`).run(deltaMs, hashToken(nonceString));
}

const P1 = 'acct-p1';
const P2 = 'acct-p2';
const SN_NEW = 'BJP00326060100000601'; // 台账 active 未绑
const SN_OUT = 'BJP00326060100000999'; // 台账外
deviceRegistryStore.add(SN_NEW, '配网测试机');
const jwt1 = await parentJwt(P1);
const jwt2 = await parentJwt(P2);

// ---------- token 签发 ----------
eq('tok-1 无家长 JWT 401', (await app.request('/api/parent/pairing/token', { method: 'POST' })).status, 401);
const t1 = await issueToken(jwt1);
eq('tok-2 签发形状', { s: t1.status, ok: t1.json.ok, exp: t1.json.expires_in_s, hasTok: typeof t1.json.bind_token === 'string' && t1.json.bind_token.length >= 30, hasId: typeof t1.json.token_id === 'string' }, { s: 200, ok: true, exp: 600, hasTok: true, hasId: true });
const t2 = await issueToken(jwt1); // 重复申请 → t1 作废
eq('tok-3 旧未用作废(旧 id 轮询 404)', (await pollStatus(jwt1, t1.json.token_id)).status, 404);
eq('tok-4 新 token pending', (await pollStatus(jwt1, t2.json.token_id)).json.state, 'pending');
eq('tok-5 他人轮询 404', (await pollStatus(jwt2, t2.json.token_id)).status, 404);

// ---------- claim 负向（先测不消耗 t2 的）----------
eq('clm-1 乱 token 401 invalid', (await claim(SN_NEW, 'no-such-token-xxxx')).json.error, 'token_invalid');
eq('clm-2 SN 格式门 400', (await claim('ADB123456', t2.json.bind_token)).status, 400);
eq('clm-3 台账外 403', { s: (await claim(SN_OUT, t2.json.bind_token)).status, e: (await claim(SN_OUT, (await issueToken(jwt1)).json.bind_token)).json.error }, { s: 403, e: 'sn_not_allowed' });
// 注意：上一行第二次 issueToken 已作废 t2 → 重新签一个干净 token 走主链
const t3 = await issueToken(jwt1);

// ---------- 首次 claim 正向 ----------
const c1 = await claim(SN_NEW, t3.json.bind_token);
eq('clm-4 首次 200 idempotent=false', { s: c1.status, ok: c1.json.ok, idem: c1.json.idempotent, brain: c1.json.brain_state }, { s: 200, ok: true, idem: false, brain: 'ready' });
eq('clm-5 响应不回显 bind_token', JSON.stringify(c1.json).includes(t3.json.bind_token), false);
{
  const cred = await verifyDeviceCredential(`Bearer ${c1.json.device_credential}`, 'test-secret');
  eq('clm-6 凭据过三通道共用验签', cred?.sn, SN_NEW);
  const days = (c1.json.credential_expires_at_ms - Date.now()) / 86_400_000;
  eq('clm-7 exp≈365d 真实毫秒值', days > 364 && days <= 365.1, true);
}
eq('clm-8 家长关联落台账', deviceRegistryStore.get(SN_NEW)?.parent_account_id, P1);
eq('clm-9 brain 账号确定性 id', deviceRegistryStore.get(SN_NEW)?.account_id, `device-${SN_NEW}`);
eq('clm-10 status 变 bound+回显 SN', (await pollStatus(jwt1, t3.json.token_id)).json, { ok: true, state: 'bound', sn: SN_NEW });

// ---------- 幂等矩阵 ----------
const c2 = await claim(SN_NEW, t3.json.bind_token); // 同 token 同 SN 窗内
eq('idem-1 幂等 200 带可用凭据', { s: c2.status, idem: c2.json.idempotent, brain: c2.json.brain_state, credOk: Boolean(await verifyDeviceCredential(`Bearer ${c2.json.device_credential}`, 'test-secret')) }, { s: 200, idem: true, brain: 'ready', credOk: true });
eq('idem-2 同 token 异 SN 401 used', (await claim('BJP00326060100000602', t3.json.bind_token)).json.error, 'token_used');
ageToken('claimed_at', t3.json.token_id, 16 * 60_000); // 超 15min 恢复窗
eq('idem-3 超恢复窗 401 used', (await claim(SN_NEW, t3.json.bind_token)).json.error, 'token_used');
{
  const t4 = await issueToken(jwt1); // 同家长新 token + 已绑同 SN
  const c4 = await claim(SN_NEW, t4.json.bind_token);
  eq('idem-4 同家长新 token 幂等 200', { s: c4.status, idem: c4.json.idempotent }, { s: 200, idem: true });
  const t5 = await issueToken(jwt2); // 其他家长 + 已绑 SN
  eq('idem-5 他人家长 409', (await claim(SN_NEW, t5.json.bind_token)).json.error, 'sn_bound_by_other');
}
{
  const t6 = await issueToken(jwt1);
  ageToken('expires_at', t6.json.token_id, 11 * 60_000); // 未 claim 且过期
  eq('idem-6 未 claim 过期 401 expired', (await claim('BJP00326060100000603', t6.json.bind_token)).json.error, 'token_expired');
  eq('idem-7 过期后 status=expired', (await pollStatus(jwt1, t6.json.token_id)).json.state, 'expired');
}

// ---------- 限流（独立 SN 收紧）----------
{
  process.env.PAIRING_CLAIM_RPM_SN = '3';
  let last = 0;
  for (let i = 0; i < 5; i += 1) last = (await claim('BJP00326060100000777', 'whatever-token-x')).status;
  eq('rate-1 SN 风暴 429', last, 429);
  process.env.PAIRING_CLAIM_RPM_SN = '100';
}

// ═══════════════ v2：nonce 桥 + ECIES ═══════════════

function newDeviceKeys() {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { priv: e.getPrivateKey() as Buffer, pkB64: b64url(e.getPublicKey(null, 'compressed') as Buffer) };
}
const newNonce = () => b64url(rndBytes(16));

async function confirm(jwt: string, sn: string, nonce: string, pk: string) {
  const res = await app.request('/api/parent/pairing/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ sn, nonce, pk, pairing_protocol: 2 }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function claimV2(sn: string, nonce: string, ip?: string) {
  const res = await app.request('/v1/device/pairing/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ sn, pairing_nonce: nonce, pairing_protocol: 2 }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const SN_V2 = 'BJP00326060100000701';
deviceRegistryStore.add(SN_V2, 'v2配网测试机');

// ---------- confirm：pk 严格验证 ----------
{
  const kp = newDeviceKeys();
  eq('v2-pk-1 合法 pk 收', (await confirm(jwt1, SN_V2, newNonce(), kp.pkB64)).status, 200);
  eq('v2-pk-2 非曲线点拒', (await confirm(jwt1, SN_V2, newNonce(), Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 0xff)]).toString('base64url'))).json.error, 'invalid_pk');
  eq('v2-pk-3 错前缀拒', (await confirm(jwt1, SN_V2, newNonce(), Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1)]).toString('base64url'))).json.error, 'invalid_pk');
  eq('v2-pk-4 带 padding 拒', (await confirm(jwt1, SN_V2, newNonce(), kp.pkB64 + '=')).status, 400);
}

// ---------- claim v2 全链：pending → confirm → claimed → 设备侧解密对撞 ----------
{
  const kp = newDeviceKeys();
  const nonce = newNonce();
  eq('v2-1 claim 早于 confirm=pending', (await claimV2(SN_V2, nonce)).json.code, 'pairing_pending');
  const cf = await confirm(jwt1, SN_V2, nonce, kp.pkB64);
  eq('v2-2 confirm 返回轮询键', typeof cf.json.session_id, 'string');
  eq('v2-3 confirm 后 status=pending(等设备)', (await app.request(`/api/parent/pairing/status?session_id=${cf.json.session_id}`, { headers: { authorization: `Bearer ${jwt1}` } }).then(r => r.json()) as any).state, 'pending');
  const c1 = await claimV2(SN_V2, nonce);
  eq('v2-4 claimed 形状', { s: c1.status, code: c1.json.code, idem: c1.json.idempotent, alg: c1.json.enc?.alg, brain: c1.json.brain_state }, { s: 200, code: 'claimed', idem: false, alg: 'ECIES-P256-HKDF-SHA256-A256GCM', brain: 'ready' });
  eq('v2-5 响应无明文凭据字段', 'device_credential' in c1.json, false);
  const jwt = decryptCredential(kp.priv, c1.json.enc, nonce, SN_V2);
  const cred = await verifyDeviceCredential(`Bearer ${jwt}`, 'test-secret');
  eq('v2-6 设备侧解密→凭据过三通道验签', cred?.sn, SN_V2);
  eq('v2-7 exp 真实毫秒≈365d', (c1.json.credential_expires_at_ms - Date.now()) / 86_400_000 > 364, true);
  // 合同终值：expires_at_ms 与 JWT exp*1000 完全一致（codex 端上双校验，毫秒尾数差=拒）
  const claims = decodeJwt(jwt) as { exp: number };
  eq('v2-7b expires_at_ms === exp*1000 精确一致', c1.json.credential_expires_at_ms, claims.exp * 1000);
  eq('v2-8 status 变 bound', (await app.request(`/api/parent/pairing/status?session_id=${cf.json.session_id}`, { headers: { authorization: `Bearer ${jwt1}` } }).then(r => r.json()) as any).state, 'bound');

  // 幂等恢复：密文不同、明文语义等价
  const c2 = await claimV2(SN_V2, nonce);
  eq('v2-9 幂等恢复 code', { code: c2.json.code, idem: c2.json.idempotent }, { code: 'idempotent_recovery', idem: true });
  eq('v2-10 幂等密文不同', c2.json.enc.ciphertext === c1.json.enc.ciphertext, false);
  const jwt2r = decryptCredential(kp.priv, c2.json.enc, nonce, SN_V2);
  eq('v2-11 幂等明文语义等价(同SN可验)', (await verifyDeviceCredential(`Bearer ${jwt2r}`, 'test-secret'))?.sn, SN_V2);

  // AAD/nonce 错必败（设备侧解密视角）
  let aadFail = false;
  try { decryptCredential(kp.priv, c2.json.enc, nonce, 'BJP00326060100000702'); } catch { aadFail = true; }
  eq('v2-12 AAD 错 SN 解密必败', aadFail, true);
  let nonceFail = false;
  try { decryptCredential(kp.priv, c2.json.enc, nonce.slice(0, -1) + (nonce.at(-1) === 'A' ? 'B' : 'A'), SN_V2); } catch { nonceFail = true; }
  eq('v2-13 nonce 错一字节解密必败', nonceFail, true);

  // 超幂等窗 → nonce_used
  ageV2('claimed_at', nonce, 16 * 60_000);
  eq('v2-14 超恢复窗 409 nonce_used', (await claimV2(SN_V2, nonce)).json.code, 'nonce_used');
}

// ---------- 过期 / SN 不匹配 / 台账外 / 已绑他人 ----------
{
  const kp = newDeviceKeys();
  const n1 = newNonce();
  await confirm(jwt1, SN_V2, n1, kp.pkB64);
  ageV2('expires_at', n1, 11 * 60_000);
  eq('v2-15 过期 410 nonce_expired', (await claimV2(SN_V2, n1)).json.code, 'nonce_expired');

  const n2 = newNonce();
  await confirm(jwt1, SN_V2, n2, kp.pkB64);
  eq('v2-16 claim SN≠confirm SN 按 pending', (await claimV2('BJP00326060100000702', n2)).json.code, 'pairing_pending');

  const n3 = newNonce();
  await confirm(jwt1, SN_OUT, n3, kp.pkB64); // SN_OUT 台账外（confirm 不查台账,claim 查）
  eq('v2-17 台账外 403', (await claimV2(SN_OUT, n3)).json.code, 'sn_not_allowed');

  const n4 = newNonce();
  await confirm(jwt2, SN_NEW, n4, kp.pkB64); // SN_NEW 已被 P1 绑定,P2 来抢
  eq('v2-18 已绑他人 409', (await claimV2(SN_NEW, n4)).json.code, 'sn_bound_by_other');
}

// ---------- v1 开关（默认关=404；上面 v1 全段已证开着时可用=回滚锚活）----------
{
  process.env.PAIRING_PROTOCOL_V1_ENABLED = '0';
  eq('v1sw-1 token 接口关', (await app.request('/api/parent/pairing/token', { method: 'POST', headers: { authorization: `Bearer ${jwt1}` } })).status, 404);
  const r = await app.request('/v1/device/pairing/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sn: SN_V2, bind_token: 'whatever-123' }) });
  eq('v1sw-2 v1 claim 关', r.status, 404);
  const kp = newDeviceKeys();
  const n = newNonce();
  await confirm(jwt1, SN_V2, n, kp.pkB64);
  eq('v1sw-3 v2 claim 不受影响', (await claimV2(SN_V2, n)).json.code, 'claimed');
  process.env.PAIRING_PROTOCOL_V1_ENABLED = '1';
}

// ═══════════════ v3：announce + 后台预授权代确认（合同 v1 草案 + codex 开工回执 2026-09-06，M1–M9）═══════════════
{
  const { pairingStore } = await import('../src/pairing-store.js');
  const { tryAutoConfirm, manualConfirm } = await import('../src/routes/pairing.js');
  const P3 = 'acct-p3';
  const SN_A = 'BJP00326060100000801'; // M1 先预授权后上线
  const SN_B = 'BJP00326060100000802'; // M2 先上线后预授权
  const SN_C = 'BJP00326060100000803'; // 家长优先
  const SN_D = 'BJP00326060100000804'; // 一键确认
  const SN_E = 'BJP00326060100000806'; // 开关 0 + TTL
  const SN_F = 'BJP00326060100000807'; // 独立限流桶
  const SN_G = 'BJP00326060100000808'; // 过期预授权
  const SN_U = 'BJP00326060100000899'; // 台账外
  for (const [sn, note] of [[SN_A, 'v3-A'], [SN_B, 'v3-B'], [SN_C, 'v3-C'], [SN_D, 'v3-D'], [SN_E, 'v3-E'], [SN_F, 'v3-F'], [SN_G, 'v3-G']]) deviceRegistryStore.add(sn, note);
  async function announce(sn: string, nonce: string, pk: string, ip?: string) {
    const res = await app.request('/v1/device/pairing/announce', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
      body: JSON.stringify({ v: 2, sn, nonce, pk }),
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  // ── 形状 / 台账外 / 无预授权 ──
  eq('an-1 nonce 形状不合 400', (await announce(SN_A, 'short', newDeviceKeys().pkB64)).status, 400);
  eq('an-2 非法 pk 400', (await announce(SN_A, newNonce(), 'AAAA' + 'B'.repeat(40))).status, 400);
  eq('an-3 台账外 SN 也 200 pending（不泄露存在性）', (await announce(SN_U, newNonce(), newDeviceKeys().pkB64)).json.state, 'pending');
  const kB = newDeviceKeys();
  const nB = newNonce();
  const aB = await announce(SN_B, nB, kB.pkB64);
  eq('an-4 无预授权 200 pending + ttl≤600', { s: aB.status, st: aB.json.state, ttl: aB.json.expires_in_s > 590 && aB.json.expires_in_s <= 600 }, { s: 200, st: 'pending', ttl: true });
  eq('an-5 无预授权 claim 仍 pairing_pending', (await claimV2(SN_B, nB)).json.code, 'pairing_pending');

  // ── M1：先预授权，设备首次上线 ──
  const kA = newDeviceKeys();
  const nA = newNonce();
  const preA = pairingStore.setPreauth(SN_A, P3, '13800000001', Date.now() + 7 * 86_400_000, 'tester');
  const aA = await announce(SN_A, nA, kA.pkB64);
  eq('m1-1 announce 即代确认 state=confirmed', aA.json.state, 'confirmed');
  const sessA = pairingStore.findSessionByHash(hashToken(nA));
  eq('m1-2 会话来源 preauth / 家长=预授权账号 / 记 created_at', { src: sessA?.source, acct: sessA?.account_id, pre: sessA?.preauth_created_at }, { src: 'preauth', acct: P3, pre: preA.created_at });
  const annAt = pairingStore.findAnnounce(SN_A)!.announced_at;
  const cA = await claimV2(SN_A, nA);
  eq('m1-3 claim 200 claimed', { s: cA.status, code: cA.json.code }, { s: 200, code: 'claimed' });
  const jwtA = decryptCredential(kA.priv, cA.json.enc, nA, SN_A);
  eq('m1-4 ECIES 解密 → 凭据三通道可验', (await verifyDeviceCredential(`Bearer ${jwtA}`, 'test-secret'))?.sn, SN_A);
  eq('m1-5 家长绑定 + brain 账号建立', { p: deviceRegistryStore.get(SN_A)?.parent_account_id, b: deviceRegistryStore.get(SN_A)?.account_id }, { p: P3, b: `device-${SN_A}` });
  eq('m1-6 预授权在真实 claim 时消费', typeof pairingStore.getPreauth(SN_A)?.used_at, 'number');
  const usedAt = pairingStore.getPreauth(SN_A)!.used_at;
  eq('m1-7 幂等恢复 code', (await claimV2(SN_A, nA)).json.code, 'idempotent_recovery');
  eq('m1-8 幂等恢复不改 used_at', pairingStore.getPreauth(SN_A)!.used_at, usedAt);
  const again = await announce(SN_A, nA, kA.pkB64);
  eq('an-6 同 nonce 重发 200 且不续命', { s: again.status, same: pairingStore.findAnnounce(SN_A)!.announced_at === annAt }, { s: 200, same: true });
  eq('an-7 同 nonce 异 pk 409 nonce_pk_mismatch', (await announce(SN_A, nA, newDeviceKeys().pkB64)).json.error, 'nonce_pk_mismatch');
  eq('an-8 新 nonce 覆盖旧代', (await announce(SN_A, newNonce(), kA.pkB64)).status === 200 && pairingStore.findAnnounce(SN_A)!.nonce_hash !== hashToken(nA), true);

  // ── M2：设备先上线，后台后预授权 ──
  pairingStore.setPreauth(SN_B, P3, '13800000002', Date.now() + 86_400_000, 'tester');
  const annB = pairingStore.findAnnounce(SN_B)!;
  eq('m2-1 晚到预授权代确认（只用 hash + pk）', tryAutoConfirm(SN_B, annB.nonce_hash, annB.device_pk, 'late_preauth').done, true);
  eq('m2-2 再触发 already_confirmed', tryAutoConfirm(SN_B, annB.nonce_hash, annB.device_pk, 'late_preauth').reason, 'already_confirmed');
  eq('m2-3 claim 200 claimed', (await claimV2(SN_B, nB)).json.code, 'claimed');

  // ── M7：家长先扫码，再来预授权/announce → 家长优先 ──
  const kC = newDeviceKeys();
  const nC = newNonce();
  await confirm(jwt1, SN_C, nC, kC.pkB64);
  pairingStore.setPreauth(SN_C, P3, '13800000003', Date.now() + 86_400_000, 'tester');
  const aC = await announce(SN_C, nC, kC.pkB64);
  const sessC = pairingStore.findSessionByHash(hashToken(nC));
  eq('m7-1 家长已确认 → 代确认跳过，会话仍是家长', { st: aC.json.state, acct: sessC?.account_id, src: sessC?.source }, { st: 'confirmed', acct: P1, src: 'parent' });
  eq('m7-2 claim 绑到扫码家长', (await claimV2(SN_C, nC)).json.code === 'claimed' && deviceRegistryStore.get(SN_C)?.parent_account_id === P1, true);
  eq('m7-3 家长优先时预授权未被消费', pairingStore.getPreauth(SN_C)?.used_at, null);
  eq('m7-4 已绑他人后预授权不代确认 sn_bound_by_other', tryAutoConfirm(SN_C, hashToken(newNonce()), kC.pkB64, 'announce').reason, 'sn_bound_by_other');

  // ── 后台一键确认（无预授权）──
  const kD = newDeviceKeys();
  const nD = newNonce();
  await announce(SN_D, nD, kD.pkB64);
  eq('adm-1 一键确认', manualConfirm(SN_D, P3, 'tester').done, true);
  eq('adm-2 重复一键确认 already_confirmed', manualConfirm(SN_D, P3, 'tester').reason, 'already_confirmed');
  const resD = await claimV2(SN_D, nD);
  eq('adm-3 claim 200 且 source=admin', { code: resD.json.code, src: pairingStore.findSessionByHash(hashToken(nD))?.source }, { code: 'claimed', src: 'admin' });
  // ── 台账「凭据」列读侧回填（2026-09-06）：claim 签发不写 device_registry.credential_*，admin 由最近 claim 会话推导 ──
  const lastD = pairingStore.lastClaimedSessionBySn(SN_D);
  eq('cred-1 lastClaimedSessionBySn 取到刚 claim 的会话', { src: lastD?.source, claimed: typeof lastD?.claimed_at === 'number' }, { src: 'admin', claimed: true });
  const credDiff = Math.abs(credentialWindowFromClaim(lastD!.claimed_at!).expires_at - Number(resD.json.credential_expires_at_ms));
  eq('cred-2 由 claimed_at 推导的到期 == claim 响应 credential_expires_at_ms（双载体，≤1s）', credDiff <= 1000 ? 'ok' : `diff_ms=${credDiff}`, 'ok');
  eq('cred-3 未 claim 过的 SN → null', pairingStore.lastClaimedSessionBySn('BJP00326060100000805'), null);
  eq('adm-4 无 announce 的 SN → no_announce', manualConfirm('BJP00326060100000805', P3, 'tester').reason, 'no_announce');

  // ── M9：开关 0 → 永不代确认；TTL 到期不续命 ──
  process.env.PAIRING_ADMIN_PREAUTH_ENABLED = '0';
  pairingStore.setPreauth(SN_E, P3, '13800000006', Date.now() + 86_400_000, 'tester');
  const kE = newDeviceKeys();
  const nE = newNonce();
  const aE = await announce(SN_E, nE, kE.pkB64);
  eq('m9-1 开关 0 → pending 且无会话', { st: aE.json.state, sess: pairingStore.findSessionByHash(hashToken(nE)) }, { st: 'pending', sess: null });
  delete process.env.PAIRING_ADMIN_PREAUTH_ENABLED;
  rawDb.prepare(`UPDATE pairing_announce SET expires_at = expires_at - ? WHERE sn = ?`).run(11 * 60_000, SN_E);
  eq('ttl-1 过期 announce 不在待认领列表', pairingStore.listAnnounces().some((a) => a.sn === SN_E), false);
  eq('ttl-2 过期同 nonce 重发不续命 ttl=0', (await announce(SN_E, nE, kE.pkB64)).json.expires_in_s, 0);
  eq('ttl-3 过期后代确认也不发生（预授权仍在）', pairingStore.findSessionByHash(hashToken(nE)), null);

  // ── 独立限流桶：announce 桶打满不影响 claim ──
  process.env.PAIRING_ANNOUNCE_RPM_SN = '2';
  const kF = newDeviceKeys();
  await announce(SN_F, newNonce(), kF.pkB64);
  await announce(SN_F, newNonce(), kF.pkB64);
  eq('rl-1 announce 桶第三次 429', (await announce(SN_F, newNonce(), kF.pkB64)).status, 429);
  eq('rl-2 claim 不受 announce 桶影响', (await claimV2(SN_F, newNonce())).json.code, 'pairing_pending');
  delete process.env.PAIRING_ANNOUNCE_RPM_SN;

  // ── 容量向量（codex v234 增量回执 2026-09-06 §2.2）：生产 claim SN30/IP120、announce 6/20 独立桶。
  //    端侧 claim 节奏 0/2/3/5s 封顶 → 单机首分钟上界 14 次；两台共出口 IP 各 14 次 claim + 各 4 次 announce
  //    交错 → 零 429；单 SN 第 31 次 429；同 IP 第 121 次 429（未满 SN 桶照拦）；claim IP 桶打满 announce 仍 200。
  //    IP 走 x-forwarded-for 首段（nginx $proxy_add_x_forwarded_for），用文档保留段 203.0.113.7 与其它用例的桶隔离。
  process.env.PAIRING_CLAIM_RPM_SN = '30';
  process.env.PAIRING_CLAIM_RPM_IP = '120';
  const IP_NAT = '203.0.113.7';
  const SN_H = 'BJP00326060100000809';
  const SN_I = 'BJP00326060100000810';
  let cap429 = 0;
  let capPending = 0;
  let capAnn = 0;
  for (let i = 0; i < 14; i += 1) {
    for (const sn of [SN_H, SN_I]) {
      const r = await claimV2(sn, newNonce(), IP_NAT);
      if (r.status === 429) cap429 += 1;
      if (r.json.code === 'pairing_pending') capPending += 1;
      if (i < 4 && (await announce(sn, newNonce(), newDeviceKeys().pkB64, IP_NAT)).status === 200) capAnn += 1;
    }
  }
  eq('rl-3 两台同 IP 各 14 次 claim + 各 4 次 announce → 零 429', { c429: cap429, pending: capPending, ann: capAnn }, { c429: 0, pending: 28, ann: 8 });
  for (let i = 14; i < 30; i += 1) await claimV2(SN_H, newNonce(), IP_NAT);
  eq('rl-4 单 SN 第 31 次 claim 429', (await claimV2(SN_H, newNonce(), IP_NAT)).status, 429);
  eq('rl-5 同 IP 另一台仍可 claim（SN 桶独立）', (await claimV2(SN_I, newNonce(), IP_NAT)).json.code, 'pairing_pending');
  // IP 桶已计 30(H)+15(I)=45，再用三台各 25 次补到 120（429 不计入桶）
  let ipFill = 0;
  for (const sn of ['BJP00326060100000811', 'BJP00326060100000812', 'BJP00326060100000813']) {
    for (let i = 0; i < 25; i += 1) if ((await claimV2(sn, newNonce(), IP_NAT)).status !== 429) ipFill += 1;
  }
  eq('rl-6 IP 桶 120 内零 429', ipFill, 75);
  eq('rl-7 同 IP 第 121 次 claim 429（SN 桶未满照拦）', (await claimV2('BJP00326060100000814', newNonce(), IP_NAT)).status, 429);
  eq('rl-8 claim IP 桶打满时 announce 仍 200（桶独立）', (await announce('BJP00326060100000814', newNonce(), newDeviceKeys().pkB64, IP_NAT)).status, 200);
  process.env.PAIRING_CLAIM_RPM_SN = '100';
  process.env.PAIRING_CLAIM_RPM_IP = '1000';

  // ── 过期预授权忽略 ──
  pairingStore.setPreauth(SN_G, P3, '13800000008', Date.now() - 1000, 'tester');
  eq('pre-1 过期预授权不代确认', (await announce(SN_G, newNonce(), newDeviceKeys().pkB64)).json.state, 'pending');
  eq('pre-2 activePreauth 过期为 null', pairingStore.activePreauth(SN_G), null);
  eq('pre-3 删除预授权', pairingStore.deletePreauth(SN_G), true);
}

console.log(`\npairing.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
