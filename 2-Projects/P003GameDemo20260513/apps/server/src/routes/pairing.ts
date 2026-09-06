import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { verifyAuthToken } from '../auth-jwt.js';
import { validateDeviceSn } from '../device-sn.js';
import { pairingStore, hashToken, IDEMPOTENT_WINDOW_MS, TOKEN_TTL_S } from '../pairing-store.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { validateDevicePk, encryptCredential, ECIES_ALG } from '../pairing-crypto.js';
import { performSnBinding } from './profile.js';

/**
 * 配网即绑定（联调合同 v3 冻结版 + 三项口径确认回执 2026-08-22）。
 *
 * 家长侧（挂 /api/parent/pairing，家长 JWT 鉴权，与 profile 同款中间件）：
 *   POST /token   签一次性 bind_token（10min，库存 hash；同家长未用旧 token 作废）
 *   GET  /status  H5 轮询：pending | bound | initializing | expired
 * 设备侧（挂 /v1/device/pairing，无凭据——claim 是设备第一次对 server 说话）：
 *   POST /claim   幂等矩阵见 v3 §3.2；判定顺序见回执 2.2（已 claim 判断优先于过期判断）。
 *                 成功（含幂等）响应携带完整可用设备凭据（365d），brain 失败不阻断（initializing）。
 *
 * 红线：bind_token / psk / 凭据不进日志；日志只记 SN、token_id、状态码。
 */

const CREDENTIAL_TTL_MS = 365 * 86_400_000; // 365d（P1 refresh 另议）

const cfg = () => ({
  authSecret: process.env.AUTH_JWT_SECRET || '',
  // v1（bind_token 协议）默认关闭（codex §3.3：弃用不删，留回滚锚；nonce E2E 全绿后物理删除）
  v1Enabled: process.env.PAIRING_PROTOCOL_V1_ENABLED === '1',
  claimRpmSn: Number(process.env.PAIRING_CLAIM_RPM_SN || 6),
  claimRpmIp: Number(process.env.PAIRING_CLAIM_RPM_IP || 20),
  // v3（2026-09-06）：后台预授权代确认开关（默认开；置 0 只禁代确认，announce 仍 200 pending、扫码链不受影响）
  preauthEnabled: process.env.PAIRING_ADMIN_PREAUTH_ENABLED !== '0',
  // announce 独立限流桶（codex 开工回执 §1：不消耗 claim 额度）
  announceRpmSn: Number(process.env.PAIRING_ANNOUNCE_RPM_SN || 6),
  announceRpmIp: Number(process.env.PAIRING_ANNOUNCE_RPM_IP || 20),
});

// ── 限流：内存滑窗（claim 按 SN 与 IP 双闸；token 接口靠家长 JWT 天然低频不单设）──
const hits = new Map<string, number[]>();
function rateLimited(key: string, rpm: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (arr.length >= rpm) {
    hits.set(key, arr);
    return true;
  }
  arr.push(now);
  hits.set(key, arr);
  return false;
}

async function signDeviceCredential(sn: string, secret: string): Promise<{ jwt: string; expMs: number }> {
  // 合同终值（codex 验收回执 2026-08-22）：credential_expires_at_ms 必须与 JWT exp*1000
  // 完全一致（端上双校验）——先取整到秒再派生两处，杜绝毫秒尾数差。
  const expS = Math.floor((Date.now() + CREDENTIAL_TTL_MS) / 1000);
  const expMs = expS * 1000;
  const jwt = await new SignJWT({ kind: 'p003-device' })
    .setSubject(sn)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expS)
    .sign(new TextEncoder().encode(secret));
  return { jwt, expMs };
}

// ─────────────────────── 家长侧 ───────────────────────

export const parentPairingRoute = new Hono<{ Variables: { accountId: string } }>();

parentPairingRoute.use('*', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const auth = await verifyAuthToken(token);
  if (!auth) return c.json({ ok: false, error: 'unauthorized' }, 401);
  c.set('accountId', auth.accountId);
  await next();
});

parentPairingRoute.post('/token', (c) => {
  if (!cfg().v1Enabled) return c.json({ ok: false, error: 'not_found' }, 404);
  const { token, tokenId, expiresInS } = pairingStore.create(c.get('accountId'));
  console.log(`[pairing] token issued account=${c.get('accountId')} token_id=${tokenId}`);
  return c.json({ ok: true, bind_token: token, token_id: tokenId, expires_in_s: expiresInS });
});

// v2 confirm（codex 开工 prompt §二-1）：三元组 SN+nonce_hash+pk 一次性固定。
// pk 在此严格验证（33B 压缩点/0x02-0x03/真在曲线上）；claim 不再收 pk——替换公钥的口子不存在。
const ConfirmSchema = z.object({
  sn: z.string().trim().min(1).max(30),
  nonce: z.string().trim().min(16).max(128),
  pk: z.string().trim().min(40).max(60),
  pairing_protocol: z.literal(2),
});

parentPairingRoute.post('/confirm', async (c) => {
  const parsed = ConfirmSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request' }, 400);
  const sn = parsed.data.sn.toUpperCase();
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_request' }, 400);
  if (!validateDevicePk(parsed.data.pk)) return c.json({ ok: false, error: 'invalid_pk' }, 400);
  // nonce 形状：canonical base64url ≥16 字符（≥128bit 由设备保证，server 只验形状）
  if (!/^[A-Za-z0-9_-]{16,}$/.test(parsed.data.nonce)) return c.json({ ok: false, error: 'bad_request' }, 400);
  const { sessionId } = pairingStore.confirmSession(c.get('accountId'), sn, parsed.data.nonce, parsed.data.pk);
  console.log(`[pairing] confirm account=${c.get('accountId')} sn=${sn} session=${sessionId}`);
  return c.json({ ok: true, session_id: sessionId });
});

parentPairingRoute.get('/status', (c) => {
  const accountId = c.get('accountId');
  // v2：session_id 轮询（confirm 后 pending=等设备 claim）
  const sessionId = c.req.query('session_id') || '';
  if (sessionId) {
    const row = pairingStore.findSessionById(sessionId);
    if (!row || row.account_id !== accountId) return c.json({ ok: false, error: 'not_found' }, 404);
    if (row.claimed_at) {
      const state = row.brain_state === 'ready' ? 'bound' : 'initializing';
      return c.json({ ok: true, state, sn: row.sn });
    }
    return c.json({ ok: true, state: Date.now() >= row.expires_at ? 'expired' : 'pending' });
  }
  // v1：token_id 轮询（随 v1 开关，默认关）
  if (!cfg().v1Enabled) return c.json({ ok: false, error: 'not_found' }, 404);
  const tokenId = c.req.query('token_id') || '';
  const row = pairingStore.findByTokenId(tokenId);
  if (!row || row.account_id !== accountId) {
    return c.json({ ok: false, error: 'not_found' }, 404);
  }
  if (row.claimed_at) {
    const state = row.brain_state === 'ready' ? 'bound' : 'initializing';
    return c.json({ ok: true, state, sn: row.claimed_sn });
  }
  return c.json({ ok: true, state: Date.now() >= row.expires_at ? 'expired' : 'pending' });
});

// ─────────────────────── 设备侧 ───────────────────────

const ClaimSchemaV1 = z.object({
  sn: z.string().trim().min(1).max(30),
  bind_token: z.string().trim().min(8).max(128),
  fw_version_code: z.number().int().nonnegative().optional(),
});

const ClaimSchemaV2 = z.object({
  sn: z.string().trim().min(1).max(30),
  pairing_nonce: z.string().trim().min(16).max(128),
  pairing_protocol: z.literal(2),
});

export const devicePairingRoute = new Hono();

devicePairingRoute.post('/claim', async (c) => {
  const conf = cfg();
  const body = await c.req.json().catch(() => ({}));

  // ── 协议分派：pairing_protocol=2（nonce 桥 + ECIES）优先；v1 受开关控制（默认关）──
  if ((body as Record<string, unknown>).pairing_protocol === 2) return claimV2(c, body, conf);

  if (!conf.v1Enabled) return c.json({ ok: false, error: 'not_found' }, 404);
  const parsed = ClaimSchemaV1.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request' }, 400);
  const sn = parsed.data.sn.toUpperCase();
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_request' }, 400);

  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
  if (rateLimited(`sn:${sn}`, conf.claimRpmSn) || rateLimited(`ip:${ip}`, conf.claimRpmIp)) {
    return c.json({ ok: false, error: 'rate_limited' }, 429);
  }

  // ── 判定顺序（回执 2.2 冻结：已 claim 判断优先于过期判断）──
  const row = pairingStore.findByHash(hashToken(parsed.data.bind_token));
  if (!row) return c.json({ ok: false, error: 'token_invalid' }, 401);

  if (row.claimed_at) {
    const inWindow = Date.now() - row.claimed_at < IDEMPOTENT_WINDOW_MS;
    if (row.claimed_sn === sn && inWindow) {
      // 幂等恢复：重签等价凭据（不保存旧 JWT；字节不同、语义等价——codex 2.2-5 口径）
      const { jwt, expMs } = await signDeviceCredential(sn, conf.authSecret);
      console.log(`[pairing] claim idempotent sn=${sn} token_id=${row.token_id}`);
      return c.json({
        ok: true,
        idempotent: true,
        device_credential: jwt,
        credential_expires_at_ms: expMs,
        brain_state: row.brain_state ?? 'initializing',
      });
    }
    return c.json({ ok: false, error: 'token_used' }, 401);
  }

  if (Date.now() >= row.expires_at) return c.json({ ok: false, error: 'token_expired' }, 401);

  // ── 首次 claim：主事务 = 绑定 + 凭据签发；brain 建档失败不回滚（initializing 可恢复）──
  const bind = performSnBinding(row.account_id, sn);
  if (!bind.ok) {
    if (bind.error === 'sn_not_available') return c.json({ ok: false, error: 'sn_not_allowed' }, 403);
    return c.json({ ok: false, error: 'sn_bound_by_other' }, 409);
  }
  // fw_version_code 只进结构化日志备查（合同：非门槛）；OTA check 的周期上报才是版本台账真源
  const brainState: 'ready' | 'initializing' = bind.brainAccountId ? 'ready' : 'initializing';
  const { jwt, expMs } = await signDeviceCredential(sn, conf.authSecret);
  pairingStore.markClaimed(hashToken(parsed.data.bind_token), sn, brainState);
  console.log(`[pairing] claim ok sn=${sn} token_id=${row.token_id} brain=${brainState} already_bound=${bind.alreadyBound} fw=${parsed.data.fw_version_code ?? '-'}`);
  return c.json({
    ok: true,
    // v3 幂等矩阵第 4 行：同家长「新 token」绑「已绑定的同 SN」也是幂等语义
    idempotent: bind.alreadyBound,
    device_credential: jwt,
    credential_expires_at_ms: expMs,
    brain_state: brainState,
  });
});

// ─────────────── claim v2（nonce 桥 + ECIES 加密交付，codex 开工 prompt §二-2/3）───────────────
//
// 判定顺序：形状门 → 限流 → 查会话（无行=404 pairing_pending，含「nonce 是假的」——不区分以免
// 泄露存在性）→ 已消费（同 SN+15min 窗内=幂等恢复，每次新 ephemeral+新 IV 重加密；否则 409
// nonce_used）→ 过期 410 → SN 与会话不匹配=404 pairing_pending（不确认 nonce 存在）→ 台账
// 403 → 绑定（brain 失败不回滚 =initializing）→ ECIES 加密交付 → 200 claimed。
// 红线：明文 JWT 只存在于加密函数入参，不进日志不进响应。
async function claimV2(c: Context, body: unknown, conf: ReturnType<typeof cfg>) {
  const parsed = ClaimSchemaV2.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request' }, 400);
  const sn = parsed.data.sn.toUpperCase();
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_request' }, 400);
  const nonce = parsed.data.pairing_nonce;

  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
  if (rateLimited(`sn:${sn}`, conf.claimRpmSn) || rateLimited(`ip:${ip}`, conf.claimRpmIp)) {
    return c.json({ ok: false, error: 'rate_limited', code: 'rate_limited' }, 429);
  }

  const row = pairingStore.findSessionByNonce(nonce);
  // 无会话 = 家长尚未 confirm（或 nonce 为假，不区分）：设备按 2s→3s→5s 抖动轮询
  if (!row) return c.json({ ok: false, code: 'pairing_pending' }, 404);

  const devicePk = validateDevicePk(row.device_pk);
  if (!devicePk) {
    // confirm 时已验过，此处失败=库损坏级异常；显眼 500 不静默
    console.error(`[pairing] v2 stored pk invalid sn=${sn} session=${row.session_id}`);
    return c.json({ ok: false, error: 'internal' }, 500);
  }

  if (row.claimed_at) {
    const inWindow = Date.now() - row.claimed_at < IDEMPOTENT_WINDOW_MS;
    if (row.sn === sn && inWindow) {
      // 幂等恢复：重签等价凭据 + 新 ephemeral/新 IV 重新加密（密文必然不同，明文语义等价）
      const { jwt, expMs } = await signDeviceCredential(sn, conf.authSecret);
      const enc = encryptCredential(devicePk, nonce, sn, jwt);
      console.log(`[pairing] v2 claim idempotent sn=${sn} session=${row.session_id}`);
      return c.json({
        ok: true,
        code: 'idempotent_recovery',
        idempotent: true,
        enc,
        credential_expires_at_ms: expMs,
        brain_state: row.brain_state ?? 'initializing',
      });
    }
    return c.json({ ok: false, code: 'nonce_used' }, 409);
  }

  if (Date.now() >= row.expires_at) return c.json({ ok: false, code: 'nonce_expired' }, 410);

  // claim 的 SN 必须与 confirm 固定的 SN 一致；不一致按 pairing_pending（不确认 nonce 存在性）
  if (row.sn !== sn) return c.json({ ok: false, code: 'pairing_pending' }, 404);

  const bind = performSnBinding(row.account_id, sn);
  if (!bind.ok) {
    if (bind.error === 'sn_not_available') return c.json({ ok: false, code: 'sn_not_allowed' }, 403);
    return c.json({ ok: false, code: 'sn_bound_by_other' }, 409);
  }
  const brainState: 'ready' | 'initializing' = bind.brainAccountId ? 'ready' : 'initializing';
  const { jwt, expMs } = await signDeviceCredential(sn, conf.authSecret);
  const enc = encryptCredential(devicePk, nonce, sn, jwt);
  pairingStore.markSessionClaimed(nonce, brainState);
  // v3：预授权在**真实 claim 成功**时消费（不在 announce/confirm 阶段；幂等恢复在上面已返回，不会二次消费）
  if (row.source === 'preauth' && row.preauth_created_at) {
    const consumed = pairingStore.consumePreauth(sn, row.preauth_created_at);
    console.log(`[pairing] preauth consumed sn=${sn} session=${row.session_id} ok=${consumed}`);
  }
  console.log(`[pairing] v2 claim ok sn=${sn} session=${row.session_id} source=${row.source ?? 'parent'} brain=${brainState} alg=${ECIES_ALG}`);
  return c.json({
    ok: true,
    code: 'claimed',
    idempotent: bind.alreadyBound,
    enc,
    credential_expires_at_ms: expMs,
    brain_state: brainState,
  });
}

// ─────────────── v3：announce（设备自报三元组）+ 后台预授权代确认（合同 v1 草案 + codex 开工回执 2026-09-06）───────────────
//
// 设备进入配网阶段 B 时把二维码同一份 {sn, nonce, pk} 报上来；服务端只存 nonce hash + 已校验 pk。
// 若该 SN 有有效预授权、台账 active、且当前没有未认领会话 → 用家长扫码同一核心 confirmSessionByHash 代确认；
// 设备随后照常轮询 claim（claim 一行不改）。独立限流桶；任何失败不影响二维码/claim 路径。

const AnnounceSchema = z.object({
  v: z.literal(2),
  sn: z.string().trim().min(1).max(30),
  nonce: z.string().trim().min(16).max(128),
  pk: z.string().trim().min(40).max(60),
});

export type AutoConfirmResult = { done: boolean; reason: string; sessionId?: string };

/** 预授权代确认（announce 到达 / 晚到预授权两个触发点共用）。家长优先：同 SN 已有未认领会话即跳过。 */
export function tryAutoConfirm(sn: string, nonceHash: string, devicePkB64: string, trigger: 'announce' | 'late_preauth'): AutoConfirmResult {
  if (!cfg().preauthEnabled) return { done: false, reason: 'disabled' };
  const preauth = pairingStore.activePreauth(sn);
  if (!preauth) return { done: false, reason: 'no_preauth' };
  const device = deviceRegistryStore.get(sn);
  if (!device || device.status !== 'active') return { done: false, reason: 'sn_not_available' };
  if (device.parent_account_id && device.parent_account_id !== preauth.parent_account_id) return { done: false, reason: 'sn_bound_by_other' };
  const existing = pairingStore.findUnclaimedSessionBySn(sn);
  if (existing) return { done: false, reason: existing.nonce_hash === nonceHash ? 'already_confirmed' : 'other_session' };
  const { sessionId } = pairingStore.confirmSessionByHash(preauth.parent_account_id, sn, nonceHash, devicePkB64, 'preauth', preauth.created_at);
  console.log(`[pairing] preauth-confirm sn=${sn} session=${sessionId} trigger=${trigger} by=${preauth.created_by || '-'}`);
  return { done: true, reason: 'confirmed', sessionId };
}

/** 后台一键确认：拿 announce 存下的 hash + pk，以指定家长账号确认。不覆盖已存在的未认领会话（家长优先）。 */
export function manualConfirm(sn: string, parentAccountId: string, by: string): AutoConfirmResult {
  const ann = pairingStore.findAnnounce(sn);
  if (!ann || ann.expires_at <= Date.now()) return { done: false, reason: 'no_announce' };
  if (!validateDevicePk(ann.device_pk)) return { done: false, reason: 'invalid_pk' };
  const device = deviceRegistryStore.get(sn);
  if (!device || device.status !== 'active') return { done: false, reason: 'sn_not_available' };
  if (device.parent_account_id && device.parent_account_id !== parentAccountId) return { done: false, reason: 'sn_bound_by_other' };
  const existing = pairingStore.findUnclaimedSessionBySn(sn);
  if (existing) return { done: false, reason: existing.nonce_hash === ann.nonce_hash ? 'already_confirmed' : 'other_session' };
  const { sessionId } = pairingStore.confirmSessionByHash(parentAccountId, sn, ann.nonce_hash, ann.device_pk, 'admin');
  console.log(`[pairing] admin-confirm sn=${sn} session=${sessionId} by=${by}`);
  return { done: true, reason: 'confirmed', sessionId };
}

devicePairingRoute.post('/announce', async (c) => {
  const conf = cfg();
  const parsed = AnnounceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request' }, 400);
  const sn = parsed.data.sn.toUpperCase();
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_request' }, 400);
  if (!/^[A-Za-z0-9_-]{16,}$/.test(parsed.data.nonce)) return c.json({ ok: false, error: 'bad_request' }, 400);
  if (!validateDevicePk(parsed.data.pk)) return c.json({ ok: false, error: 'invalid_pk' }, 400);
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
  if (rateLimited(`asn:${sn}`, conf.announceRpmSn) || rateLimited(`aip:${ip}`, conf.announceRpmIp)) {
    return c.json({ ok: false, error: 'rate_limited' }, 429);
  }
  const now = Date.now();
  const nonceHash = hashToken(parsed.data.nonce);
  const up = pairingStore.upsertAnnounce(sn, nonceHash, parsed.data.pk, now);
  if (up.outcome === 'pk_mismatch') {
    console.log(`[pairing] announce sn=${sn} outcome=pk_mismatch`);
    return c.json({ ok: false, error: 'nonce_pk_mismatch' }, 409);
  }
  // TTL 到期的 announce（同 nonce 过期重发不续命）不代确认：设备应轮换 nonce 重发
  const auto = up.row.expires_at > now
    ? tryAutoConfirm(sn, nonceHash, parsed.data.pk, 'announce')
    : ({ done: false, reason: 'announce_expired' } as AutoConfirmResult);
  const session = pairingStore.findSessionByHash(nonceHash);
  const state = session && !session.claimed_at && session.expires_at > now ? 'confirmed' : 'pending';
  const expiresInS = Math.max(0, Math.min(TOKEN_TTL_S, Math.ceil((up.row.expires_at - now) / 1000)));
  console.log(`[pairing] announce sn=${sn} outcome=${up.outcome} auto=${auto.reason} state=${state} ttl=${expiresInS}`);
  return c.json({ ok: true, state, expires_in_s: expiresInS });
});
