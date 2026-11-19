import { createHmac, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { verifyAuthToken } from '../auth-jwt.js';
import { accountStore } from '../account-store.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { profileStore } from '../profile-store.js';
import { getBleBindingStore, BleBindingError, type BleBindingRecord } from '../ble-binding-store.js';
import { encryptCredential, validateDevicePk } from '../pairing-crypto.js';

type Vars = { accountId: string; requestId: string };
const messages: Record<string, string> = {
  unauthorized: '请先登录', bad_request: '请求格式不正确', device_not_available: '设备尚不支持身份验证，请联系工作人员',
  device_already_bound: '该设备已绑定其他账号', device_proof_invalid: '设备身份验证失败，请重新连接设备',
  device_proof_required: '请通过蓝牙完成设备身份验证', binding_not_found: '未找到绑定记录',
  binding_changed: '绑定状态已变化，请重新连接设备', challenge_expired: '绑定验证已超时，请重试',
  claim_expired: '设备激活会话已过期，请由原账号重新连接设备', pairing_pending: '等待原账号完成设备绑定',
  rate_limited: '操作频繁，请稍后重试', binding_temporarily_unavailable: '设备绑定服务暂不可用，请稍后重试',
};
function errorResponse(c: Context, error: string, status: number) {
  const requestId = c.get('requestId') || randomUUID();
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: false, error, message: messages[error] || messages.binding_temporarily_unavailable, request_id: requestId }, status as 400);
}
function failed(c: Context, error: unknown) {
  if (error instanceof BleBindingError) return errorResponse(c, error.error, error.status);
  // Never serialize request bodies, upstream errors, nonces, signatures or credentials.
  console.error(`[ble-binding] unavailable request_id=${c.get('requestId') || '-'}`);
  return errorResponse(c, 'binding_temporarily_unavailable', 503);
}
const limits = new Map<string, { until: number; count: number }>();
function limited(key: string, max: number): boolean {
  const now = Date.now();
  if (limits.size > 4096) for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
  let entry = limits.get(key);
  if (!entry || entry.until <= now) {
    if (!entry && limits.size >= 8192) return true;
    entry = { until: now + 60_000, count: 0 }; limits.set(key, entry);
  }
  return ++entry.count > max;
}
function rateError(c: Context) { c.header('Retry-After', '60'); return errorResponse(c, 'rate_limited', 429); }

/** Pure receipt view: cloud binding, network and activation are deliberately distinct. */
function currentBrainState(row: BleBindingRecord) {
  if (row.brain_state !== 'ready') return row.brain_state;
  const id = deviceRegistryStore.get(row.sn)?.account_id;
  return id === `device-${row.sn}` && accountStore.findAccount(id)?.role === 'device' ? 'ready' : 'unavailable';
}
export function receipt(row: BleBindingRecord, alreadyBound: boolean) {
  return {
    binding_id: row.binding_id, binding_state: 'bound', binding_version: row.binding_version,
    device: { sn: row.sn, public_id: row.public_id }, already_bound: alreadyBound,
    brain_state: currentBrainState(row),
    activation_state: row.activated_at_ms !== null ? 'activated' : row.claimed_at_ms !== null ? 'pending_device_auth' : 'pending_network',
    bound_at_ms: row.bound_at_ms,
  };
}
export function initializeBrain(accountId: string, row: BleBindingRecord): BleBindingRecord {
  if (row.brain_state === 'ready') return row;
  try {
    return getBleBindingStore().ensureBrain(accountId, row.binding_id, locked => {
      const brainId = `device-${locked.sn}`;
      if (locked.brain_account_id && locked.brain_account_id !== brainId) throw new Error('invalid Brain mapping');
      const account = accountStore.findAccount(brainId) || accountStore.createDeviceAccount(locked.sn, '');
      if (account.role !== 'device') throw new Error('invalid Brain account');
      if (!profileStore.getProfile(brainId)) {
        if (!profileStore.copyProfile(accountId, brainId)) profileStore.upsertProfile(brainId, { nickname: '', birthday: '', gender: '' });
      }
      return brainId;
    });
  } catch (error) {
    if (error instanceof BleBindingError) throw error;
    console.warn(`[ble-binding] brain_initializing binding_id=${row.binding_id}`);
    return getBleBindingStore().getBinding(accountId, row.binding_id);
  }
}

export const bleBindingsRoute = new Hono<{ Variables: Vars }>();
bleBindingsRoute.use('*', async (c, next) => {
  c.set('requestId', randomUUID()); c.header('Cache-Control', 'no-store');
  const secret = process.env.AUTH_JWT_SECRET || '';
  if (secret !== secret.trim() || Buffer.byteLength(secret) < 32) return errorResponse(c, 'binding_temporarily_unavailable', 503);
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() || '')?.[1];
  const auth = await verifyAuthToken(token);
  if (!auth || auth.role !== 'parent' || accountStore.findAccount(auth.accountId)?.role !== 'parent') return errorResponse(c, 'unauthorized', 401);
  c.set('accountId', auth.accountId);
  if (limited(`parent:${auth.accountId}`, 90)) return rateError(c);
  await next();
});
bleBindingsRoute.use('*', bodyLimit({ maxSize: 4096, onError: c => errorResponse(c, 'bad_request', 400) }));
bleBindingsRoute.post('/challenge', async c => {
  if (limited(`challenge:${c.get('accountId')}`, 12)) return rateError(c);
  try {
    const result = getBleBindingStore().createChallenge(c.get('accountId'), await c.req.json().catch(() => null));
    return c.json({ ok: true, ...result, request_id: c.get('requestId') });
  } catch (error) { return failed(c, error); }
});
const Confirm = z.object({ challenge_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), device_signature: z.string().min(1).max(100) }).strict();
bleBindingsRoute.post('/confirm', async c => {
  const input = Confirm.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return errorResponse(c, 'bad_request', 400);
  try {
    const row = getBleBindingStore().confirm(c.get('accountId'), input.data.challenge_id, input.data.device_signature);
    const initialized = initializeBrain(c.get('accountId'), row);
    console.log(`[ble-binding] bound request_id=${c.get('requestId')} binding_id=${row.binding_id} account_id=${row.account_id}`);
    return c.json({ ok: true, ...receipt(initialized, row.already_bound), request_id: c.get('requestId') });
  } catch (error) { return failed(c, error); }
});
bleBindingsRoute.get('/:binding_id', c => {
  try {
    const row = getBleBindingStore().getBinding(c.get('accountId'), c.req.param('binding_id'));
    return c.json({ ok: true, ...receipt(initializeBrain(c.get('accountId'), row), true), request_id: c.get('requestId') });
  } catch (error) { return failed(c, error); }
});

const Claim = z.object({ binding_protocol: z.literal('ble-key-v1'), sn: z.string().max(30), pairing_nonce: z.string().max(64) }).strict();
/** Called only by the new explicitly selected claim branch; does not bind or replace the owner. */
export function claimBleCredential(c: Context, body: unknown) {
  c.set('requestId', randomUUID()); c.header('Cache-Control', 'no-store');
  const parsed = Claim.safeParse(body);
  if (!parsed.success) return errorResponse(c, 'bad_request', 400);
  const { sn, pairing_nonce: nonce } = parsed.data;
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (limited(`claim-sn:${sn}`, 12) || limited(`claim-ip:${ip}`, 60)) return rateError(c);
  const secret = process.env.AUTH_JWT_SECRET || '';
  if (secret !== secret.trim() || Buffer.byteLength(secret) < 32) return errorResponse(c, 'binding_temporarily_unavailable', 503);
  try {
    const response = getBleBindingStore().claim(sn, nonce, row => {
      const pk = validateDevicePk(row.credential_pk);
      if (!pk) throw new Error('invalid stored credential key');
      const iat = Math.floor(Date.now() / 1000); const exp = iat + 365 * 86400;
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ kind: 'p003-device', sub: sn, iat, exp, binding_version: row.binding_version, ble_binding_id: row.binding_id })).toString('base64url');
      const signing = `${header}.${payload}`;
      const jwt = `${signing}.${createHmac('sha256', secret).update(signing).digest('base64url')}`;
      return {
        ok: true, code: row.idempotent ? 'idempotent_recovery' : 'claimed', idempotent: row.idempotent,
        binding_protocol: 'ble-key-v1', binding_id: row.binding_id, binding_version: row.binding_version,
        enc: encryptCredential(pk, nonce, sn, jwt), credential_expires_at_ms: exp * 1000, brain_state: currentBrainState(row),
      };
    });
    return c.json(response);
  } catch (error) { return failed(c, error); }
}

/** Called after a successful device authentication flow. No client supplied status can activate a device. */
export function noteBleActivation(sn: string, bindingVersion: number | undefined, bindingId?: string) {
  if (bindingVersion === undefined || !bindingId) return;
  getBleBindingStore().markActivated(sn, bindingVersion, bindingId);
}
