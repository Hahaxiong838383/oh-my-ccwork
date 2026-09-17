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
 *  - 恢复合同 S1（2026-09-17，rv-*）：announce v:3 已绑→bound_recoverable / v:2→pending（通道独占锚）/ 停用 denied / 台账外 pending /
 *    有效预授权仍优先 confirmed；原家长 confirm relation=owner → claim(v:3) binding_outcome=existing_binding_recovery（按凭据历史判，
 *    claim 会话或后台手签都算）+ 旧凭据作废（水位 iat−1）+ 幂等不推水位；预绑家长新机首次 claim 仍 new；他人 confirm 409 不建会话 /
 *    台账外·停用 404（claim 级门保留给 confirm→claim 竞态）；请求不带 v:3 无 binding_outcome；开关 0 全老行为
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
process.env.STUDIO_USER = 'test-admin'; // admin 路由（待认领列表 / 一键确认）用真实 /api/auth/login 拿 token，测试内绝不打印 token
process.env.STUDIO_PASS = 'test-pass';

const { Hono } = await import('hono');
const { SignJWT, decodeJwt } = await import('jose');
const { DatabaseSync } = await import('node:sqlite');
const { parentPairingRoute, devicePairingRoute } = await import('../src/routes/pairing.js');
const { authRoute } = await import('../src/routes/auth.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
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
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);

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

async function claimV2(sn: string, nonce: string, ip?: string, v?: 3) {
  const res = await app.request('/v1/device/pairing/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ sn, pairing_nonce: nonce, pairing_protocol: 2, ...(v ? { v } : {}) }),
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

  // 恢复合同（2026-09-17）起 confirm 前置查台账/绑定：台账外 404、他人 409 且不建会话；claim 级门保留给 confirm→claim 之间的竞态
  const n3 = newNonce();
  eq('v2-17a 台账外 confirm 404 sn_not_available（不建会话）', (await confirm(jwt1, SN_OUT, n3, kp.pkB64)).json.error, 'sn_not_available');
  eq('v2-17b 无会话 → claim pairing_pending', (await claimV2(SN_OUT, n3)).json.code, 'pairing_pending');
  const SN_DIS = 'BJP00326060100000703';
  deviceRegistryStore.add(SN_DIS, 'v2停用竞态机');
  const n3b = newNonce();
  await confirm(jwt1, SN_DIS, n3b, kp.pkB64);
  deviceRegistryStore.setStatus(SN_DIS, 'disabled'); // confirm 后被停用
  eq('v2-17 confirm 后停用 → claim 403 sn_not_allowed（claim 级台账门保留）', (await claimV2(SN_DIS, n3b)).json.code, 'sn_not_allowed');

  const n4 = newNonce();
  const cf4 = await confirm(jwt2, SN_NEW, n4, kp.pkB64); // SN_NEW 已被 P1 绑定,P2 来抢
  eq('v2-18a 已绑他人 confirm 409 sn_bound_by_other（不建会话）', { s: cf4.status, e: cf4.json.error }, { s: 409, e: 'sn_bound_by_other' });
  eq('v2-18b 无会话 → claim pairing_pending', (await claimV2(SN_NEW, n4)).json.code, 'pairing_pending');
  const SN_RACE = 'BJP00326060100000704';
  deviceRegistryStore.add(SN_RACE, 'v2抢绑竞态机');
  const n4b = newNonce();
  await confirm(jwt2, SN_RACE, n4b, kp.pkB64);
  deviceRegistryStore.setParentAccountId(SN_RACE, P1); // confirm 后后台绑给 P1
  eq('v2-18 confirm 后被绑他人 → claim 409（claim 级防抢绑保留）', (await claimV2(SN_RACE, n4b)).json.code, 'sn_bound_by_other');
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

  // ── 已认领后 announce 行残留（2026-09-07 眼镜展两台实撞）：claim 完成后 announce 行还在 10 分钟 TTL 内，
  //    后台列表把它当「待确认」，一键确认撞 nonce_hash 主键 → 500「一键确认失败」。修法：按本 nonce 会话判态，已 claim 温和拒绝。──
  const { announceState } = await import('../src/routes/pairing.js');
  // SN_B：announce nB → 晚到预授权代确认 → m2-3 已 claim；announce 行仍是 nB
  eq('adm-5 已认领会话的 announce 再一键确认 → already_claimed（不抛、不 500）', (() => { try { return manualConfirm(SN_B, P3, 'tester').reason; } catch (e) { return `threw:${(e as Error).message}`; } })(), 'already_claimed');
  pairingStore.setPreauth(SN_B, P3, '13800000002', Date.now() + 86_400_000, 'tester');
  eq('adm-6 已认领后再来预授权，对同 nonce 不代确认 → already_claimed', (() => { try { return tryAutoConfirm(SN_B, annB.nonce_hash, annB.device_pk, 'late_preauth').reason; } catch (e) { return `threw:${(e as Error).message}`; } })(), 'already_claimed');
  eq('adm-7 已认领后预授权未被误消费', pairingStore.getPreauth(SN_B)?.used_at, null);
  const claimedB = pairingStore.findSessionByHash(annB.nonce_hash)!;
  const nowP = Date.now();
  eq('pend-1 announceState 本 nonce 已 claim → claimed', announceState(claimedB, null, nowP), 'claimed');
  eq('pend-2 announceState 本 nonce 已确认未 claim → confirmed', announceState({ ...claimedB, claimed_at: null, expires_at: nowP + 60_000 }, null, nowP), 'confirmed');
  eq('pend-3 announceState 本 nonce 无会话但同 SN 有未认领会话（家长扫码）→ confirmed', announceState(null, { ...claimedB, claimed_at: null, expires_at: nowP + 60_000 }, nowP), 'confirmed');
  eq('pend-4 announceState 无会话 → pending', announceState(null, null, nowP), 'pending');
  eq('pend-5 announceState 本 nonce 会话已过期未 claim → pending', announceState({ ...claimedB, claimed_at: null, expires_at: nowP - 1 }, null, nowP), 'pending');
  // 路由级：真实 /api/auth/login 拿 admin token（不打印），待认领列表标 claimed，一键确认 409 带可读文案
  const loginRes = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-pass' }) });
  const adminToken = ((await loginRes.json()) as { token?: string }).token ?? '';
  eq('adm-login admin 登录成功', loginRes.status === 200 && adminToken.length > 20, true);
  const pendRes = await app.request('/api/admin/devices/pairing/pending', { headers: { authorization: `Bearer ${adminToken}` } });
  const pendJson = (await pendRes.json()) as { ok: boolean; items: Array<{ sn: string; state: string; claimed_at: number | null; confirmed_by: string | null }> };
  const itemB = pendJson.items.find((i) => i.sn === SN_B);
  eq('pend-6 待认领列表：已 claim 的 announce 标 claimed + 带 claimed_at/来源', { st: itemB?.state, at: typeof itemB?.claimed_at, by: itemB?.confirmed_by }, { st: 'claimed', at: 'number', by: 'preauth' });
  const confRes = await app.request(`/api/admin/devices/${SN_B}/pairing/confirm`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: '{}' });
  const confJson = (await confRes.json()) as { ok: boolean; error?: string; reason?: string };
  eq('adm-8 一键确认已认领设备 → 409 already_claimed + 可读文案（不是 500）', { s: confRes.status, r: confJson.reason, readable: /已完成认领/.test(confJson.error ?? '') }, { s: 409, r: 'already_claimed', readable: true });

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

// ═══════════════ 恢复合同 S1（2026-09-17，回 codex V286「绑定权威恢复」）：announce v:3 绑定态 / claim binding_outcome / confirm 前置检查 / 恢复换钥 ═══════════════
{
  const { pairingStore } = await import('../src/pairing-store.js');
  const { deviceAnnounceState } = await import('../src/routes/pairing.js');
  // 本段 announce 十余次且无 x-forwarded-for（全算 ip=unknown），会撞前面各段累计的 IP 桶 20/min → 放开限流（限流本身在 rl-* 已验）
  process.env.PAIRING_ANNOUNCE_RPM_SN = '100';
  process.env.PAIRING_ANNOUNCE_RPM_IP = '1000';
  const P4 = 'acct-p4';
  const P5 = 'acct-p5';
  const jwt4 = await parentJwt(P4);
  const jwt5 = await parentJwt(P5);
  const SN_R1 = 'BJP00326060100000901'; // 已绑 + 有 claim 凭据历史 → 恢复
  const SN_R2 = 'BJP00326060100000902'; // 后台预绑家长、从未签凭据 → 首次 claim 仍 new
  const SN_R3 = 'BJP00326060100000903'; // 停用 → denied
  const SN_R4 = 'BJP00326060100000904'; // 未绑 → pending
  const SN_R5 = 'BJP00326060100000905'; // 已绑 + 有效预授权 → announce 直接 confirmed（优先级）
  const SN_R6 = 'BJP00326060100000906'; // 已绑 + 后台手签凭据（registry 列）→ 恢复也算 existing
  const SN_RU = 'BJP00326060100000998'; // 台账外
  for (const [sn, note] of [[SN_R1, 'rv-1'], [SN_R2, 'rv-2'], [SN_R3, 'rv-3'], [SN_R4, 'rv-4'], [SN_R5, 'rv-5'], [SN_R6, 'rv-6']]) deviceRegistryStore.add(sn, note);
  async function announceV(v: 2 | 3, sn: string, nonce: string, pk: string) {
    const res = await app.request('/v1/device/pairing/announce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v, sn, nonce, pk }) });
    return { status: res.status, json: (await res.json()) as any };
  }
  /** 换钥判据以秒为单位：让「旧凭据」与「新凭据」不落在同一秒，否则水位 iat−1 会放行旧凭据（真机恢复必隔很久，测试要人为跨秒） */
  const crossSecond = () => new Promise((r) => setTimeout(r, 1100 - (Date.now() % 1000)));

  // ── 造凭据历史：P4 首次配网 SN_R1（new），拿到第一份凭据 ──
  const k1 = newDeviceKeys();
  const n1 = newNonce();
  const cf1 = await confirm(jwt4, SN_R1, n1, k1.pkB64);
  eq('rv-0a 未绑 confirm 200 relation=new', { s: cf1.status, rel: cf1.json.relation }, { s: 200, rel: 'new' });
  const c1 = await claimV2(SN_R1, n1, undefined, 3);
  eq('rv-0b 首次 claim（v:3）binding_outcome=new', { code: c1.json.code, bo: c1.json.binding_outcome, idem: c1.json.idempotent }, { code: 'claimed', bo: 'new', idem: false });
  const jwtOld = decryptCredential(k1.priv, c1.json.enc, n1, SN_R1);
  eq('rv-0c 第一份凭据可验', (await verifyDeviceCredential(`Bearer ${jwtOld}`, 'test-secret'))?.sn, SN_R1);
  eq('rv-0d 首次 claim 不换钥（水位 null）', deviceRegistryStore.credentialNotBeforeSec(SN_R1), null);
  const brainBefore = deviceRegistryStore.get(SN_R1)?.account_id;

  // ── rv-1 announce：同一已绑 SN，v:3 → bound_recoverable；v:2 → pending（通道独占锚）──
  const k2 = newDeviceKeys();
  const n2 = newNonce();
  const a3 = await announceV(3, SN_R1, n2, k2.pkB64);
  eq('rv-1a v:3 已绑无会话 → bound_recoverable，且不带家长信息', { s: a3.status, st: a3.json.state, keys: Object.keys(a3.json).sort() }, { s: 200, st: 'bound_recoverable', keys: ['expires_in_s', 'ok', 'state'] });
  eq('rv-1b v:2 同 SN 同 nonce → pending（老端映射）', (await announceV(2, SN_R1, n2, k2.pkB64)).json.state, 'pending');
  // ── rv-2 v:3 其它态 ──
  eq('rv-2a v:3 台账外 → pending（不泄露存在性）', (await announceV(3, SN_RU, newNonce(), newDeviceKeys().pkB64)).json.state, 'pending');
  deviceRegistryStore.setStatus(SN_R3, 'disabled');
  const aD = await announceV(3, SN_R3, newNonce(), newDeviceKeys().pkB64);
  eq('rv-2b v:3 停用 → denied + reason', { st: aD.json.state, r: aD.json.reason }, { st: 'denied', r: 'sn_not_available' });
  eq('rv-2c v:3 未绑 → pending', (await announceV(3, SN_R4, newNonce(), newDeviceKeys().pkB64)).json.state, 'pending');
  deviceRegistryStore.setParentAccountId(SN_R5, P4);
  pairingStore.setPreauth(SN_R5, P4, '13800000009', Date.now() + 86_400_000, 'tester');
  eq('rv-2d 已绑 + 有效预授权 → announce 直接 confirmed（预授权优先于 bound_recoverable）', (await announceV(3, SN_R5, newNonce(), newDeviceKeys().pkB64)).json.state, 'confirmed');

  // ── rv-3 原家长扫码恢复：confirm relation=owner → claim existing_binding_recovery，绑定/brain 不变，凭据可验 ──
  await crossSecond();
  const cf2 = await confirm(jwt4, SN_R1, n2, k2.pkB64);
  eq('rv-3a 原家长 confirm 200 relation=owner', { s: cf2.status, rel: cf2.json.relation }, { s: 200, rel: 'owner' });
  eq('rv-3b confirm 后 announce 同 nonce → confirmed', (await announceV(3, SN_R1, n2, k2.pkB64)).json.state, 'confirmed');
  const c2 = await claimV2(SN_R1, n2, undefined, 3);
  eq('rv-3c claim claimed + binding_outcome=existing_binding_recovery + idempotent=true', { code: c2.json.code, bo: c2.json.binding_outcome, idem: c2.json.idempotent }, { code: 'claimed', bo: 'existing_binding_recovery', idem: true });
  const jwtNew = decryptCredential(k2.priv, c2.json.enc, n2, SN_R1);
  eq('rv-3d 新凭据三通道可验', (await verifyDeviceCredential(`Bearer ${jwtNew}`, 'test-secret'))?.sn, SN_R1);
  eq('rv-3e 家长与 brain 账号不变', { p: deviceRegistryStore.get(SN_R1)?.parent_account_id, b: deviceRegistryStore.get(SN_R1)?.account_id }, { p: P4, b: brainBefore });
  eq('rv-3f status bound 带 binding_outcome', await app.request(`/api/parent/pairing/status?session_id=${cf2.json.session_id}`, { headers: { authorization: `Bearer ${jwt4}` } }).then((r) => r.json()), { ok: true, state: 'bound', sn: SN_R1, binding_outcome: 'existing_binding_recovery' });
  eq('rv-3g 会话落库 binding_outcome', pairingStore.findSessionByHash(hashToken(n2))?.binding_outcome, 'existing_binding_recovery');
  // ── rv-6 恢复即换钥：旧凭据失效、新凭据通过；幂等重试不推水位 ──
  eq('rv-6a 旧凭据作废', await verifyDeviceCredential(`Bearer ${jwtOld}`, 'test-secret'), null);
  const wm1 = deviceRegistryStore.credentialNotBeforeSec(SN_R1);
  eq('rv-6b 水位 = 新凭据 iat − 1（双载体同源）', wm1, (decodeJwt(jwtNew) as { iat: number }).iat - 1);
  await crossSecond();
  const c3 = await claimV2(SN_R1, n2, undefined, 3);
  eq('rv-6c 幂等恢复回显 binding_outcome', { code: c3.json.code, bo: c3.json.binding_outcome }, { code: 'idempotent_recovery', bo: 'existing_binding_recovery' });
  eq('rv-6d 幂等重试不推水位，第一份新凭据仍通过', { wm: deviceRegistryStore.credentialNotBeforeSec(SN_R1), ok: (await verifyDeviceCredential(`Bearer ${jwtNew}`, 'test-secret'))?.sn }, { wm: wm1, ok: SN_R1 });
  eq('rv-6e 请求不带 v:3 → 响应无 binding_outcome（老端）', 'binding_outcome' in (await claimV2(SN_R1, n2)).json, false);

  // ── rv-4 后台预绑家长的新机首次 claim → new（无凭据历史）──
  const k4 = newDeviceKeys();
  const n4 = newNonce();
  deviceRegistryStore.setParentAccountId(SN_R2, P5);
  eq('rv-4a v:3 预绑家长未签过凭据 → bound_recoverable（announce 只看绑定）', (await announceV(3, SN_R2, n4, k4.pkB64)).json.state, 'bound_recoverable');
  eq('rv-4b 该家长 confirm relation=owner', (await confirm(jwt5, SN_R2, n4, k4.pkB64)).json.relation, 'owner');
  const c4 = await claimV2(SN_R2, n4, undefined, 3);
  eq('rv-4c 首次 claim binding_outcome=new（idempotent=true 但无凭据历史）', { bo: c4.json.binding_outcome, idem: c4.json.idempotent }, { bo: 'new', idem: true });
  eq('rv-4d 无换钥（水位 null）', deviceRegistryStore.credentialNotBeforeSec(SN_R2), null);
  // ── rv-5 他人 confirm 409 不建会话；台账外 / 停用 404 ──
  const n6 = newNonce();
  const cf6 = await confirm(jwt5, SN_R1, n6, newDeviceKeys().pkB64);
  eq('rv-5a 他人 confirm 409 sn_bound_by_other', { s: cf6.status, e: cf6.json.error }, { s: 409, e: 'sn_bound_by_other' });
  eq('rv-5b 不建会话 → claim pending', (await claimV2(SN_R1, n6)).json.code, 'pairing_pending');
  eq('rv-5c 台账外 confirm 404', (await confirm(jwt5, SN_RU, newNonce(), newDeviceKeys().pkB64)).status, 404);
  eq('rv-5d 停用 confirm 404', (await confirm(jwt5, SN_R3, newNonce(), newDeviceKeys().pkB64)).status, 404);
  // ── rv-5e 后台手签凭据（registry 列）也算凭据历史 → 恢复 + 换钥 ──
  deviceRegistryStore.setParentAccountId(SN_R6, P4);
  deviceRegistryStore.recordCredential(SN_R6, Date.now() - 86_400_000, Date.now() + 300 * 86_400_000);
  const k6 = newDeviceKeys();
  const n6b = newNonce();
  await confirm(jwt4, SN_R6, n6b, k6.pkB64);
  const c6 = await claimV2(SN_R6, n6b, undefined, 3);
  eq('rv-5e 手签凭据历史 → existing_binding_recovery + 水位落地', { bo: c6.json.binding_outcome, wm: typeof deviceRegistryStore.credentialNotBeforeSec(SN_R6) }, { bo: 'existing_binding_recovery', wm: 'number' });
  // ── rv-7 admin 待认领列表：已绑 announce 带 parent_bound ──
  const loginR = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-pass' }) });
  const adminTok = ((await loginR.json()) as { token?: string }).token ?? '';
  const pendR = await app.request('/api/admin/devices/pairing/pending', { headers: { authorization: `Bearer ${adminTok}` } });
  const pendItems = ((await pendR.json()) as { items: Array<{ sn: string; parent_bound: boolean }> }).items;
  eq('rv-7 待认领项 parent_bound：已绑 true / 未绑 false', { r1: pendItems.find((i) => i.sn === SN_R1)?.parent_bound, r4: pendItems.find((i) => i.sn === SN_R4)?.parent_bound }, { r1: true, r4: false });
  // ── rv-8 开关 0：一律老行为 ──
  process.env.PAIRING_RECOVERY_CONTRACT_ENABLED = '0';
  const k8 = newDeviceKeys();
  const n8 = newNonce();
  eq('rv-8a 开关 0 → v:3 已绑也 pending', (await announceV(3, SN_R1, n8, k8.pkB64)).json.state, 'pending');
  const cf8 = await confirm(jwt5, SN_R1, n8, k8.pkB64); // 他人也能 confirm（老行为），claim 侧 409
  eq('rv-8b 开关 0 → confirm 不前置检查且无 relation', { s: cf8.status, rel: cf8.json.relation }, { s: 200, rel: undefined });
  const c8 = await claimV2(SN_R1, n8, undefined, 3);
  eq('rv-8c 开关 0 → claim 级门 409 且无 binding_outcome', { code: c8.json.code, bo: c8.json.binding_outcome }, { code: 'sn_bound_by_other', bo: undefined });
  delete process.env.PAIRING_RECOVERY_CONTRACT_ENABLED;
  // ── rv-9 纯函数判定序 ──
  const nowR = Date.now();
  eq('rv-9a 会话优先于绑定态', deviceAnnounceState({ session: { claimed_at: null, expires_at: nowR + 1000 }, device: { status: 'active', parent_account_id: 'x' }, now: nowR, v3: true, enabled: true }).state, 'confirmed');
  eq('rv-9b 已 claim 的会话不算 → 走绑定判定', deviceAnnounceState({ session: { claimed_at: nowR, expires_at: nowR + 1000 }, device: { status: 'active', parent_account_id: 'x' }, now: nowR, v3: true, enabled: true }).state, 'bound_recoverable');
  eq('rv-9c v:2 → pending', deviceAnnounceState({ session: null, device: { status: 'active', parent_account_id: 'x' }, now: nowR, v3: false, enabled: true }).state, 'pending');
  eq('rv-9d 开关关 → pending', deviceAnnounceState({ session: null, device: { status: 'disabled', parent_account_id: null }, now: nowR, v3: true, enabled: false }).state, 'pending');
  delete process.env.PAIRING_ANNOUNCE_RPM_SN;
  delete process.env.PAIRING_ANNOUNCE_RPM_IP;
}

console.log(`\npairing.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
