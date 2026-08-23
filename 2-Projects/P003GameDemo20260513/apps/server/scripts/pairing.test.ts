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
const { hashToken } = await import('../src/pairing-store.js');
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

async function claimV2(sn: string, nonce: string) {
  const res = await app.request('/v1/device/pairing/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

console.log(`\npairing.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
