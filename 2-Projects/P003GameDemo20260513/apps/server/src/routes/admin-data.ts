import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { accountStore } from '../account-store.js';
import { otaAdminRoute } from './ota.js';
import { configAdminRoute } from './device-config.js';
import { conversationStore } from '../conversation-store.js';
import { profileStore } from '../profile-store.js';
import { memoryItemStore } from '../memory-item-store.js';
import { canWrite, getTokenUser, isAdminRole, isValidToken } from './auth.js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { configStore } from '../config-store.js';
import { resolveFirstTurnPolicy, FIRST_TURN_POLICIES, FIRST_TURN_POLICY_FLAG } from './device-session.js';
import { resetAllQuotas } from '../guard.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { extractionLogStore } from '../extraction-log-store.js';
import { validateDeviceSn } from '../device-sn.js';
import { buildDeviceLayers, resolveDeviceIdentity } from '../device-brain-prompt.js';
import { AI_SAFETY_BASELINE } from '../ai-literacy.js';
import {
  hotwordStore,
  validateWords,
  subsetWarnings,
  KIND_TO_ENV,
  HOTWORD_KINDS,
  type HotwordKind,
} from '../hotword-store.js';
import { callHotwordChannel } from '../hotword-channel.js';
import { extractLlmStore, EXTRACT_PROVIDERS, type ExtractProvider } from '../extract-llm-store.js';
import {
  relationStateStore, personaTrackEnabled, personaInjectEnabled, personaStyleEnabled,
  personaInsightEnabled, personaNarrativeEnabled, personaTraitEnabled, personaLocalAudioEnabled,
} from '../relation-state-store.js';
import { localAudioStore } from '../local-audio-store.js';
import { runLocalAudioForAccount, kickoffLocalAudioOnce } from '../local-audio-generator.js';
import { pairingStore, credentialWindowFromClaim } from '../pairing-store.js';
import { tryAutoConfirm, manualConfirm, announceState, type AutoConfirmResult } from './pairing.js';
import { stylePoolStore } from '../style-pool-store.js';
import { childInsightStore } from '../child-insight-store.js';
import { runInsightForAccount, runNarrativeForAccount } from '../insight-runner.js';
import { traitStore, TRAIT_BASELINE, TRAIT_LABELS, TRAIT_DIMS } from '../trait-store.js';
import { listStyleTemplates, getStyleTemplate, type StyleTemplateKey } from '../style-template.js';
import { growthLedgerStore } from '../growth-ledger-store.js';
import { resolveExtractLlm, callExtractionLlm } from '../llm-extract.js';

// hub 看板数据端点：admin 看所有账号的孩子档案 + 设备（admin token 鉴权，区别于 parent 自己的 /api/profile 邀请码 JWT）。
const adminDataRoute = new Hono();

adminDataRoute.use('*', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  // 邀请码管理（/api/admin/invites 及 /invites/:code）= admin 专属：editor / guest 连查看（GET）都 403。
  // editor「除邀请码管理外与 admin 同权」的边界就落在这里（真防线；前端隐藏邀请码 tab 只是 UX）。
  if (/\/invites(?:\/|$)/.test(c.req.path) && !isAdminRole(token)) {
    return c.json({ ok: false, error: 'forbidden_invites', message: '无邀请码管理权限' }, 403);
  }
  // 设备接入管理（/devices、/device-sessions、/worker-stats、/hotwords）= admin 专属，
  // 敏感度 ≥ 邀请码（凭据签发入口；hotwords 的发布会重启生产 worker）。
  if (/\/(devices|device-sessions|worker-stats|hotwords|extract-llm|isolation-overview|ota|device-config|worker-race|worker-voice|oneshot)(?:\/|$)/.test(c.req.path) && !isAdminRole(token)) {
    return c.json({ ok: false, error: 'forbidden_devices', message: '无设备接入管理权限' }, 403);
  }
  // 只读门控（真防线）：guest 仅可 GET（查看）；写操作（POST/DELETE/PATCH）需 admin/editor，否则 403。
  // 前端隐藏编辑按钮只是 UX，这里才是 guest 改不了数据的保证。
  if (c.req.method !== 'GET' && !canWrite(token)) {
    return c.json({ ok: false, error: 'forbidden_readonly', message: '游客账号只读，无编辑权限' }, 403);
  }
  await next();
});

// 列所有孩子档案 + 关联设备（按账号聚合）
adminDataRoute.get('/profiles', (c) => {
  const deviceByAccount = new Map(profileStore.listAllDevices().map((d) => [d.account_id, d]));
  const profiles = profileStore.listAllProfiles().map((p) => ({
    ...p,
    device: deviceByAccount.get(p.account_id) ?? null,
  }));
  return c.json({ ok: true, profiles });
});

adminDataRoute.get('/invites', (c) => {
  try {
    const stats = conversationStore.statsByAccount();
    const invites = accountStore.listCodes().map((invite) => {
      const account = accountStore.findAccount(invite.account_id);
      const profile = profileStore.getProfile(invite.account_id);
      const stat = stats[invite.account_id];
      return {
        code: invite.code,
        account_id: invite.account_id,
        account_nickname: account?.nickname ?? '',
        child_nickname: profile?.nickname ?? '',
        used_at: invite.used_at,
        conv_count: stat?.count ?? 0,
        token_sum: stat?.tokens ?? 0,
        created_at: invite.created_at,
      };
    });
    return c.json({ ok: true, invites, count: invites.length, limit: 15 });
  } catch (error) {
    return c.json({ ok: false, error: '拉取邀请码失败，请稍后重试' }, 500);
  }
});

adminDataRoute.post('/invites', (c) => {
  try {
    const invite = accountStore.createInvite();
    return c.json({ ok: true, invite });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'invite_limit') {
      return c.json({ ok: false, error: '已达上限 15 个，请先删除部分邀请码' }, 400);
    }
    return c.json({ ok: false, error: '生成邀请码失败，请稍后重试' }, 500);
  }
});

adminDataRoute.delete('/invites/:code', (c) => {
  try {
    const code = c.req.param('code').trim();
    if (!code) return c.json({ ok: false, error: '邀请码不能为空' }, 400);

    const invite = accountStore.findByCode(code);
    if (!invite) return c.json({ ok: false, error: '邀请码不存在' }, 404);

    const deleted = accountStore.deleteInvite(code);
    if (!deleted) return c.json({ ok: false, error: '邀请码不存在' }, 404);
    profileStore.deleteByAccountId(invite.account_id);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '删除邀请码失败，请稍后重试' }, 500);
  }
});

adminDataRoute.patch('/invites/:code', async (c) => {
  try {
    const code = c.req.param('code').trim();
    if (!code) return c.json({ ok: false, error: '邀请码不能为空' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { nickname?: unknown };
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    if (!nickname) return c.json({ ok: false, error: '昵称不能为空' }, 400);

    const invite = accountStore.findByCode(code);
    if (!invite) return c.json({ ok: false, error: '邀请码不存在' }, 404);

    accountStore.updateNickname(invite.account_id, nickname);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '更新昵称失败，请稍后重试' }, 500);
  }
});

// ── 设备接入管理（运营台「设备接入」tab；全部 admin 专属，门控在上面 use('*') 中间件）──
// 白名单语义：DB 有记录以 DB status 为准；无记录回落 env DEVICE_SN_ALLOW（存量真机兜底，绝不动 env）。

// 台账列表 + env 兜底设备 + 今日统计
adminDataRoute.get('/devices', (c) => {
  try {
    // 绑定家长可视化（2026-08-23）：join 家长账号手机号（admin 内部台，显示全号便于核对；
    // 手机号只出现在 admin 鉴权接口，不进 worker 日志/普通用户接口）
    const now = Date.now();
    const devices = deviceRegistryStore.list().map((d) => ({
      ...d,
      ...credentialView(d),
      parent_phone: d.parent_account_id ? (accountStore.findAccount(d.parent_account_id)?.phone ?? null) : null,
      preauth: preauthView(pairingStore.getPreauth(d.sn), now),
    }));
    const envAllow = (process.env.DEVICE_SN_ALLOW || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const stats = deviceRegistryStore.todayStats();
    return c.json({ ok: true, devices, env_allow: envAllow, stats });
  } catch (error) {
    return c.json({ ok: false, error: '拉取设备台账失败，请稍后重试' }, 500);
  }
});

/** 台账「凭据」列读侧回填（2026-09-06，0006 首台免手传设备暴露）：配网 claim（v1/v2）签发的凭据只进 ECIES 载荷，
 *  不写 device_registry.credential_*，台账会显示「未签发」而设备已在正常鉴权。后台手工签发写过台账则台账优先；
 *  否则取最近一次 claim 成功会话推导窗口，并打 credential_source 标记——占位必须带来源，判定认标记不认内容。 */
type CredentialSource = 'registry' | 'pairing_claim' | null;
export function credentialView(d: { sn: string; credential_issued_at: number | null; credential_expires_at: number | null }): {
  credential_issued_at: number | null;
  credential_expires_at: number | null;
  credential_source: CredentialSource;
} {
  if (d.credential_expires_at) {
    return { credential_issued_at: d.credential_issued_at, credential_expires_at: d.credential_expires_at, credential_source: 'registry' };
  }
  const claimed = pairingStore.lastClaimedSessionBySn(d.sn);
  if (claimed?.claimed_at) {
    const w = credentialWindowFromClaim(claimed.claimed_at);
    return { credential_issued_at: w.issued_at, credential_expires_at: w.expires_at, credential_source: 'pairing_claim' };
  }
  return { credential_issued_at: null, credential_expires_at: null, credential_source: null };
}

// ── 后台预授权自动认领 v1（2026-09-06）：SN + 家长手机号 = 预授权；设备 announce 到达即代确认，claim 拿凭据，免手传 ──
const PHONE_RE = /^1[3-9]\d{9}$/;
const PREAUTH_DAYS_DEFAULT = Math.max(1, Number(process.env.PAIRING_PREAUTH_DAYS || 7));
function preauthView(p: ReturnType<typeof pairingStore.getPreauth>, now = Date.now()) {
  return p ? { phone: p.phone, until_at: p.until_at, used_at: p.used_at, created_at: p.created_at, active: p.until_at > now && p.used_at === null } : null;
}
function opUser(c: { req: { header: (k: string) => string | undefined } }): string {
  const t = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '')?.[1];
  return (t && getTokenUser(t)) || '?';
}
type PreauthApply =
  | { ok: true; parentAccountId: string; created: boolean; preauth: NonNullable<ReturnType<typeof preauthView>>; auto: AutoConfirmResult | null }
  | { ok: false; error: string };
/** 预授权 + 家长绑定 + 晚到 announce 代确认（添加设备 / PUT preauth 共用）。 */
function applyPreauth(sn: string, phone: string, days: number, by: string): PreauthApply {
  const existing = accountStore.findByPhone(phone);
  if (existing && existing.role === 'device') return { ok: false, error: '该手机号对应设备账号，不能绑定为家长' };
  const device = deviceRegistryStore.get(sn);
  if (!device) return { ok: false, error: '设备不在台账中' };
  const acct = existing ?? accountStore.upsertPhoneAccount(phone);
  if (device.parent_account_id && device.parent_account_id !== acct.id) return { ok: false, error: '该设备已绑定其他家长，换绑请走现役解绑/换绑流程' };
  if (!device.parent_account_id) {
    deviceRegistryStore.setParentAccountId(sn, acct.id);
    console.log(`[admin-brain] parent bound=${acct.id} sn=${sn} via=preauth${existing ? '' : '(预建账号)'}`);
  }
  const p = pairingStore.setPreauth(sn, acct.id, phone, Date.now() + days * 86_400_000, by);
  const ann = pairingStore.findAnnounce(sn);
  const auto = ann && ann.expires_at > Date.now() ? tryAutoConfirm(sn, ann.nonce_hash, ann.device_pk, 'late_preauth') : null;
  console.log(`[pairing] preauth set sn=${sn} days=${days} by=${by} late_announce=${ann ? 'yes' : 'no'} auto=${auto?.reason ?? '-'}`);
  return { ok: true, parentAccountId: acct.id, created: !existing, preauth: preauthView(p)!, auto };
}

// 已上线待认领（announce 列表；每次拉取顺手清过期）
adminDataRoute.get('/devices/pairing/pending', (c) => {
  try {
    pairingStore.purgeExpiredAnnounces();
    const now = Date.now();
    const items = pairingStore.listAnnounces(now).map((a) => {
      const device = deviceRegistryStore.get(a.sn);
      const session = pairingStore.findUnclaimedSessionBySn(a.sn, now);
      const byHash = pairingStore.findSessionByHash(a.nonce_hash);
      const state = announceState(byHash, session, now);
      return {
        sn: a.sn,
        registered: Boolean(device),
        status: device?.status ?? null,
        note: device?.note ?? '',
        parent_phone: device?.parent_account_id ? (accountStore.findAccount(device.parent_account_id)?.phone ?? null) : null,
        announced_at: a.announced_at,
        expires_at: a.expires_at,
        expires_in_s: Math.max(0, Math.ceil((a.expires_at - now) / 1000)),
        state,
        confirmed_by: state === 'claimed' ? (byHash?.source ?? null) : (session?.source ?? null),
        session_id: state === 'claimed' ? (byHash?.session_id ?? null) : (session?.session_id ?? null),
        claimed_at: state === 'claimed' ? (byHash?.claimed_at ?? null) : null,
        preauth: preauthView(pairingStore.getPreauth(a.sn), now),
      };
    });
    return c.json({ ok: true, items, preauth_enabled: process.env.PAIRING_ADMIN_PREAUTH_ENABLED !== '0', preauth_days_default: PREAUTH_DAYS_DEFAULT });
  } catch (error) {
    console.error('[pairing] pending list failed', error);
    return c.json({ ok: false, error: '拉取待认领列表失败' }, 500);
  }
});

// 预授权：写/覆盖（覆盖即重新计时）
adminDataRoute.put('/devices/:sn/preauth', async (c) => {
  try {
    const sn = c.req.param('sn').trim().toUpperCase();
    const body = (await c.req.json().catch(() => ({}))) as { phone?: unknown; days?: unknown };
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const days = typeof body.days === 'number' && body.days >= 1 && body.days <= 90 ? Math.floor(body.days) : PREAUTH_DAYS_DEFAULT;
    if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'SN 不合法' }, 400);
    if (!PHONE_RE.test(phone)) return c.json({ ok: false, error: '家长手机号格式不对' }, 400);
    const r = applyPreauth(sn, phone, days, opUser(c));
    if (!r.ok) return c.json({ ok: false, error: r.error }, 409);
    return c.json({ ok: true, preauth: r.preauth, parent_account_id: r.parentAccountId, parent_created: r.created, auto_confirm: r.auto });
  } catch (error) {
    return c.json({ ok: false, error: '预授权失败，请稍后重试' }, 500);
  }
});

adminDataRoute.delete('/devices/:sn/preauth', (c) => {
  try {
    const sn = c.req.param('sn').trim().toUpperCase();
    const removed = pairingStore.deletePreauth(sn);
    console.log(`[pairing] preauth removed sn=${sn} by=${opUser(c)} removed=${removed}`);
    return c.json({ ok: true, removed });
  } catch (error) {
    return c.json({ ok: false, error: '取消预授权失败' }, 500);
  }
});

// 一键确认：人工代按（无预授权也可；家长账号 = 指定手机号 / 指定账号 / 台账已绑家长）
adminDataRoute.post('/devices/:sn/pairing/confirm', async (c) => {
  try {
    const sn = c.req.param('sn').trim().toUpperCase();
    const body = (await c.req.json().catch(() => ({}))) as { phone?: unknown; parent_account_id?: unknown };
    if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'SN 不合法' }, 400);
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中，请先添加' }, 404);
    let parentAccountId: string | null = null;
    if (typeof body.parent_account_id === 'string' && body.parent_account_id.trim()) {
      const acct = accountStore.findAccount(body.parent_account_id.trim());
      if (!acct || acct.role === 'device') return c.json({ ok: false, error: '家长账号不存在' }, 404);
      parentAccountId = acct.id;
    } else if (typeof body.phone === 'string' && PHONE_RE.test(body.phone.trim())) {
      const phone = body.phone.trim();
      const existing = accountStore.findByPhone(phone);
      if (existing && existing.role === 'device') return c.json({ ok: false, error: '该手机号对应设备账号，不能绑定为家长' }, 400);
      parentAccountId = (existing ?? accountStore.upsertPhoneAccount(phone)).id;
    } else if (device.parent_account_id) {
      parentAccountId = device.parent_account_id;
    } else {
      return c.json({ ok: false, error: '需要家长手机号（该设备尚未绑定家长）' }, 400);
    }
    const r = manualConfirm(sn, parentAccountId, opUser(c));
    if (!r.done) {
      const msg: Record<string, string> = {
        no_announce: '设备近 10 分钟没有自报上线，等它联网后再试',
        already_claimed: '设备已完成认领，凭据已下发，无需再确认',
        already_confirmed: '已确认，等设备自动拉取凭据',
        other_session: '该设备已有家长扫码确认的会话（家长优先）',
        sn_bound_by_other: '设备已绑定其他家长',
        sn_not_available: '设备不在台账或已停用',
        invalid_pk: '设备自报的公钥不合法，请让设备重新配网',
      };
      return c.json({ ok: false, error: msg[r.reason] ?? r.reason, reason: r.reason }, r.reason === 'no_announce' ? 404 : 409);
    }
    if (!device.parent_account_id) deviceRegistryStore.setParentAccountId(sn, parentAccountId);
    return c.json({ ok: true, session_id: r.sessionId, parent_account_id: parentAccountId });
  } catch (error) {
    console.error(`[pairing] admin-confirm failed sn=${c.req.param('sn')}`, error);
    return c.json({ ok: false, error: '一键确认失败，请稍后重试' }, 500);
  }
});

adminDataRoute.post('/devices', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { sn?: unknown; note?: unknown; parent_phone?: unknown };
    const sn = typeof body.sn === 'string' ? body.sn.trim().toUpperCase() : '';
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const parentPhone = typeof body.parent_phone === 'string' ? body.parent_phone.trim() : '';
    const check = validateDeviceSn(sn);
    if (!check.ok) {
      return c.json({ ok: false, error: 'reason' in check ? check.reason : 'SN 不合法' }, 400);
    }
    if (deviceRegistryStore.get(sn)) {
      return c.json({ ok: false, error: '该 SN 已在台账中' }, 409);
    }
    // 家长手机号预绑（2026-08-31）：已注册即添加时绑定；未注册照样添加但返回体明确提示，
    // 绝不静默丢弃（此前 UI 筛选框被误当添加字段、后端不收 phone，填了也无痕）。
    let parentAccount = parentPhone ? accountStore.findByPhone(parentPhone) : null;
    if (parentAccount && parentAccount.role === 'device') {
      return c.json({ ok: false, error: '该手机号对应设备账号，不能绑定为家长' }, 400);
    }
    deviceRegistryStore.add(sn, note);
    let parentBound = false;
    let preauthResult: PreauthApply | null = null;
    if (parentPhone && PHONE_RE.test(parentPhone)) {
      // 2026-09-06 川哥拍板：SN + 手机号 = 预授权自动认领。未注册手机号按短信登录同一套 upsert 预建家长账号
      // （之后家长用该号登录即同账号），绑定家长 + 写预授权；设备联网 announce 到达即代确认 → claim 拿凭据。
      preauthResult = applyPreauth(sn, parentPhone, PREAUTH_DAYS_DEFAULT, opUser(c));
      parentBound = preauthResult.ok;
    } else if (parentAccount) {
      deviceRegistryStore.setParentAccountId(sn, parentAccount.id);
      parentBound = true;
      console.log(`[admin-brain] parent bound=${parentAccount.id} sn=${sn} via=add-device`);
    }
    return c.json({
      ok: true,
      device: deviceRegistryStore.get(sn),
      parent_bound: parentBound,
      ...(preauthResult?.ok
        ? { preauth: preauthResult.preauth, parent_created: preauthResult.created, auto_confirm: preauthResult.auto }
        : preauthResult
          ? { parent_bind_warning: preauthResult.error }
          : parentPhone && !parentBound
            ? { parent_bind_warning: `手机号 ${parentPhone} 格式不对——设备已添加但未绑定/未预授权。` }
            : {}),
    });
  } catch (error) {
    return c.json({ ok: false, error: '添加设备失败，请稍后重试' }, 500);
  }
});

adminDataRoute.patch('/devices/:sn', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    if (!deviceRegistryStore.get(sn)) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: unknown; note?: unknown };
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        return c.json({ ok: false, error: 'status 只能是 active / disabled' }, 400);
      }
      deviceRegistryStore.setStatus(sn, body.status);
    }
    if (body.note !== undefined && typeof body.note === 'string') {
      deviceRegistryStore.setNote(sn, body.note.trim());
    }
    return c.json({ ok: true, device: deviceRegistryStore.get(sn) });
  } catch (error) {
    return c.json({ ok: false, error: '更新设备失败，请稍后重试' }, 500);
  }
});

// 删除台账记录（流水保留）。删除后该 SN 回落 env 语义：env 里有则继续放行。
adminDataRoute.delete('/devices/:sn', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const deleted = deviceRegistryStore.remove(sn);
    if (!deleted) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '删除设备失败，请稍后重试' }, 500);
  }
});

// 签发设备凭据（device JWT）——一次性返回，DB 只存签发/到期时间，token 原文不入库不进日志。
adminDataRoute.post('/devices/:sn/credential', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中，请先添加' }, 404);
    if (device.status !== 'active') {
      return c.json({ ok: false, error: '设备已停用，恢复启用后才能签发凭据' }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
    const days = Number(body.days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return c.json({ ok: false, error: '有效期须为 1–365 的整数天数' }, 400);
    }
    // 设备凭据是生产身份：secret 未配置就拒签，绝不回落开发默认值。
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) return c.json({ ok: false, error: '签发服务未配置（AUTH_JWT_SECRET）' }, 503);

    // JWT 时间是秒粒度：先对齐到秒，响应/落库值必须与 token claims 全等（同 device-session 自检原则）。
    const issuedAtSec = Math.floor(Date.now() / 1000);
    const expiresAtSec = issuedAtSec + days * 24 * 60 * 60;
    const issuedAtMs = issuedAtSec * 1000;
    const expiresAtMs = expiresAtSec * 1000;
    // 与 scripts/sign-device-credential.ts 完全同参：verifyDeviceCredential 零改动即可验。
    const token = await new SignJWT({ kind: 'p003-device' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sn)
      .setIssuedAt(issuedAtSec)
      .setExpirationTime(expiresAtSec)
      .sign(new TextEncoder().encode(secret));

    deviceRegistryStore.recordCredential(sn, issuedAtMs, expiresAtMs);
    const header = c.req.header('authorization');
    const opToken = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
    console.log(
      `[admin-devices] credential issued sn=${sn} days=${days} by=${opToken ? getTokenUser(opToken) ?? '?' : '?'}`,
    );
    return c.json({ ok: true, token, issued_at_ms: issuedAtMs, expires_at_ms: expiresAtMs });
  } catch (error) {
    return c.json({ ok: false, error: '签发凭据失败，请稍后重试' }, 500);
  }
});

// ── Worker Brain（设备维度的 prompt/记忆管理；admin 专属，门控随 /devices 路径正则）──
// 模型：每台设备 ↔ 一个 brain 账号（registry.account_id）。记忆/画像数据都挂账号维度，
// 与体验台同一套 store（profile.db），运营台只是设备视角的入口。

// 开通/绑定 brain：无 account_id 则自动建设备专属账号（device-<SN>，幂等），并签身份 JWT
// （与邀请码登录 JWT 同参，verifyAuthToken 可验）——rust 侧调 /v1 时以 ?token= 携带即注入该账号记忆。
// token 一次性返回不落库；重复开通 = 幂等返回绑定 + 重签新 token（旧 token 无吊销机制，白名单/过期为准）。
adminDataRoute.post('/devices/:sn/brain', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中，请先添加' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { account_id?: unknown };
    let accountId: string;
    if (typeof body.account_id === 'string' && body.account_id.trim()) {
      accountId = body.account_id.trim();
      if (!accountStore.findAccount(accountId)) {
        return c.json({ ok: false, error: `账号 ${accountId} 不存在` }, 404);
      }
    } else {
      accountId = accountStore.createDeviceAccount(sn, device.note).id;
    }
    deviceRegistryStore.setAccountId(sn, accountId);

    // 自动建档（2026-08-19）：无档时记忆抽取会静默跳过（memory-extractor「没建档不抽」门），
    // 设备链路没有家长端建档步骤 → 开通即建。取数优先级：家长档同步 > 空档兜底（空档已足以
    // 激活抽取；昵称/性别可后续在运营台档案区或语音 onboarding 补全）。
    if (!profileStore.getProfile(accountId)) {
      const synced = device.parent_account_id
        ? profileStore.copyProfile(device.parent_account_id, accountId)
        : null;
      if (!synced) profileStore.upsertProfile(accountId, { nickname: '', birthday: '', gender: '' });
      console.log(`[admin-brain] 建档 sn=${sn} account=${accountId} source=${synced ? 'parent:' + device.parent_account_id : 'blank'}`);
    }

    // brain_token 分发已取消（2026-08-20 川哥拍板）：多设备架构下身份由房名 SN 路由，
    // worker 只需一个进程级通行证（已配置）；per-device token 无消费场景，返回它只会
    // 误导运营「要找地方填」。通行证续签走 scripts/sign-worker-token.ts（唯一签发口）。
    // 绑定即生成（2026-09-06）：建档后异步触发一次本地音频生成，不阻塞路由、失败只留日志；
    // 已生成过的账号由门判跳过，生成本身仍受每日批同一套门（暂停开关/体积预检/发布门）约束。
    console.log(`[admin-brain] local-audio kickoff ${kickoffLocalAudioOnce(accountId, 'admin-brain-open')} sn=${sn} account=${accountId}`);
    console.log(`[admin-brain] opened sn=${sn} account=${accountId}`);
    return c.json({ ok: true, account_id: accountId });
  } catch (error) {
    return c.json({ ok: false, error: '开通 brain 失败，请稍后重试' }, 500);
  }
});

// 解绑（registry.account_id 置空；账号与记忆保留，重新绑定即恢复）
adminDataRoute.delete('/devices/:sn/brain', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    if (!device.account_id) return c.json({ ok: false, error: '该设备未开通 brain' }, 400);
    deviceRegistryStore.setAccountId(sn, null);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '解绑失败，请稍后重试' }, 500);
  }
});

// 聚合视图：账号 + 画像 + 全量 typed 记忆 + 归档情绪计数 + system prompt 预览（稳态组装）。
adminDataRoute.get('/devices/:sn/brain', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    if (!device.account_id) return c.json({ ok: true, bound: false });

    const accountId = device.account_id;
    const account = accountStore.findAccount(accountId);
    const profile = profileStore.getProfile(accountId);
    const { items, archived_emotion_count } = memoryItemStore.listByAccount(accountId);
    const parentAccount = device.parent_account_id ? accountStore.findAccount(device.parent_account_id) : null;
    // 最近对话（设备维度聊天记录可见性，2026-08-19）：设备账号的 conversation 按时间倒序。
    const recentConversation = conversationStore
      .list({ accountId, limit: 50 })
      .map((r) => ({ id: r.id, session_id: r.session_id, role: r.role, text: r.text, ts: r.ts }));
    // P0 人格成长（契约+codex 3.3 可观测）：关系状态 + 注入视图 + promise 兑现率（trust 只读代理，查询时算不落库）。
    const relationState = relationStateStore.getState(accountId);
    const relationView = relationState ? relationStateStore.getInjectionView(accountId, Date.now()) : null;
    const promiseStats = (() => {
      try {
        const promises = items.filter((i) => i.type === 'promise');
        const resolved = promises.filter((i) => i.status === 'resolved').length;
        return { total: promises.length, resolved };
      } catch {
        return { total: 0, resolved: 0 };
      }
    })();
    // 分层组装（device-brain-prompt，与 custom-llm 热路径同源）：世界观/安全基座/记忆区块/附加规则 + 最终成品。
    // 课程/启蒙/召回护栏是逐轮按孩子发言动态叠加的，不在稳态分层内。
    const { layers, final } = buildDeviceLayers({ accountId, role: 'device' });
    return c.json({
      ok: true,
      bound: true,
      account_id: accountId,
      account_nickname: account?.nickname ?? '',
      profile: profile
        ? {
            nickname: profile.nickname,
            birthday: profile.birthday,
            gender: profile.gender,
            interests: profile.interests.map((i) => ({ value: i.value, state: i.state ?? 'unverified', evidence: i.evidence ?? '', mention_days: i.mention_days ?? [], retracted_by: i.retracted_by ?? '' })),
            preferred_address: profile.preferred_address,
            recent_emotion: profile.recent_emotion,
            game_progress: profile.game_progress.map((g) => ({ value: g.value })),
          }
        : null,
      items: items.filter((it) => it.status !== 'retracted'),
      archived_emotion_count,
      parent_account_id: device.parent_account_id ?? null,
      parent_nickname: parentAccount?.nickname ?? '',
      recent_conversation: recentConversation,
      relation_state: relationState
        ? {
            days_known: relationView?.daysKnown ?? 0,
            tier: relationView?.tier ?? '新朋友',
            session_count: relationState.session_count,
            miss: relationView?.miss ?? 0,
            mood: relationView?.mood ?? null,
            valence_ema: relationState.valence_ema,
            engagement_ema: relationState.engagement_ema,
            valence_sample_count: relationState.valence_sample_count,
            engagement_sample_count: relationState.engagement_sample_count,
            last_seen_at: relationState.last_seen_at,
            promise_total: promiseStats.total,
            promise_resolved: promiseStats.resolved,
          }
        : null,
      prompt_config: {
        worldview_override: device.worldview_override ?? '',
        prompt_addendum: device.prompt_addendum ?? '',
      },
      prompt_layers: layers,
      prompt_preview: final,
      server_now: Date.now(),
    });
  } catch (error) {
    return c.json({ ok: false, error: '拉取 brain 数据失败，请稍后重试' }, 500);
  }
});

// 租户隔离白盒（2026-08-19）：五跳隔离链每跳的实时真值 + 统一配置矩阵。
// 原则：声明与证据并排——每条「隔离保证」旁必须是现场查询/现场跑生产同一函数的结果，
// 绝不硬编码「已隔离」文案（白盒面板一旦与代码漂移，比黑盒更危险）。机制说明文案在前端展示层。
adminDataRoute.get('/devices/:sn/isolation', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    const bound = Boolean(device.account_id);
    const accountId = device.account_id ?? null;

    // ── 跳1 接入准入：白名单判定路径复现（与 device-session isSnAllowed 同序：DB status 优先 → env 兜底）──
    const snCheck = validateDeviceSn(sn);
    const envAllow = (process.env.DEVICE_SN_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
    const dbStatus = deviceRegistryStore.statusOf(sn);
    const allowSource = dbStatus !== null
      ? (dbStatus === 'active' ? 'db_active' : 'db_disabled')
      : envAllow.includes(sn) ? 'env_allow' : 'denied';
    const access = {
      sn_valid: snCheck.ok,
      allow_source: allowSource,
      db_status: dbStatus,
      env_allow_count: envAllow.length,
      env_allow_hit: envAllow.includes(sn),
      ttl_s: Number(process.env.DEVICE_SESSION_TTL_S || 3600),
      rpm: Number(process.env.DEVICE_SESSION_RPM || 10),
      recent_sessions: deviceRegistryStore.listSessions(sn, 5).map((r) => ({
        room: r.room, session_id: r.session_id, status: r.status, ttl_s: r.ttl_s, created_at: r.created_at,
      })),
    };

    // ── 跳2 身份路由一致性自检：现场跑生产同一 resolveDeviceIdentity——喂「web 家长 token 身份 +
    //    本设备房名」，验证 token 身份被丢弃、路由到设备自己账号（防串号的关键行为，不是文案是现场证据）──
    const PROBE_TOKEN_ACCOUNT = '__isolation_probe__';
    const resolved = resolveDeviceIdentity({ accountId: PROBE_TOKEN_ACCOUNT, role: 'parent' }, `sn-${sn}-0`);
    const identity = {
      room_pattern: `sn-${sn}-<unix秒>`,
      probe_token_account: PROBE_TOKEN_ACCOUNT,
      resolved_account: resolved?.accountId ?? null,
      resolved_role: resolved?.role ?? null,
      registry_account: accountId,
      // 开通 → 必须路由到 registry 账号且绝不沿用 token 身份；未开通 → 必须匿名（null，绝不串到兜底账号）
      match: bound
        ? resolved?.accountId === accountId && resolved?.accountId !== PROBE_TOKEN_ACCOUNT
        : resolved === null,
    };

    // ── 跳3 prompt 分层元数据（与热路径同源 buildDeviceLayers；全文预览在「拼接可视化」sub-tab）──
    const promptLayers = bound
      ? buildDeviceLayers({ accountId: accountId!, role: 'device' }).layers.map((l) => ({
          key: l.key, label: l.label, source: l.source, editable: l.editable, chars: l.chars,
        }))
      : [];

    // ── 跳4 数据边界：本账号 vs 全库邻居并排（隔离锚——边界可见才可证伪）──
    const memMineActive = bound
      ? memoryItemStore.listByAccount(accountId!).items.filter((it) => it.status === 'active').length
      : 0;
    const memGlobal = memoryItemStore.globalStats();
    const convoStats = conversationStore.statsByAccount();
    const data = {
      profile_exists: bound ? Boolean(profileStore.getProfile(accountId!)) : false,
      memory_mine_active: memMineActive,
      memory_global_active: memGlobal.total_active,
      memory_accounts: memGlobal.distinct_accounts,
      conversation_mine: bound ? (convoStats[accountId!]?.count ?? 0) : 0,
      conversation_global: Object.values(convoStats).reduce((s, v) => s + v.count, 0),
      conversation_accounts: Object.keys(convoStats).length,
      total_accounts: accountStore.listAccounts().length,
    };

    // ── 跳5 LLM 双通道：主对话（env 全局，含 else 默认分支显性化）+ 抽取（admin 配置优先，热生效）──
    const chatRaw = (process.env.LLM_PROVIDER || '').toLowerCase();
    const chatProvider = chatRaw === 'race' ? 'race（deepseek 主 + doubao 兜底）'
      : chatRaw === 'minimax' ? 'minimax'
        : chatRaw === 'deepseek' ? 'deepseek'
          : `gemini（else 默认分支：LLM_PROVIDER=${chatRaw || '未配置'}）`;
    const ex = resolveExtractLlm();
    const llm = {
      chat_provider: chatProvider,
      chat_scope: 'global（所有设备共用，改 .env 需重启）',
      extract: {
        provider: ex.provider, model: ex.model, base_url: ex.baseUrl ?? '',
        source: ex.source, api_key_masked: maskKey(ex.apiKey ?? ''),
      },
    };

    // ── 配置矩阵：排查一屏看全「配置项 / 当前值 / 来源 / 作用域 / 生效方式 / 在哪改」──
    const wv = device.worldview_override?.trim() ?? '';
    const ad = device.prompt_addendum?.trim() ?? '';
    const config_matrix = [
      { layer: '接入', item: '设备状态', value: dbStatus ?? '不在台账（回落 env）', source: 'DB 台账', scope: 'per-SN', effect: '即时', where: '设备接入 tab' },
      { layer: '接入', item: 'env 白名单', value: `${envAllow.length} 台（DB 无记录时兜底）`, source: 'env DEVICE_SN_ALLOW', scope: 'global', effect: '重启生效', where: '.env' },
      { layer: '接入', item: 'session TTL', value: `${access.ttl_s}s`, source: 'env DEVICE_SESSION_TTL_S', scope: 'global', effect: '下次签发', where: '.env' },
      { layer: '接入', item: '签发限频', value: `${access.rpm}/min/SN`, source: 'env DEVICE_SESSION_RPM', scope: 'per-SN', effect: '下次签发', where: '.env' },
      { layer: '身份', item: '房名模式', value: 'sn-<SN>-<unix秒>', source: 'S2B1 合同（代码常量）', scope: 'global', effect: '不可变', where: '—' },
      { layer: 'prompt', item: '世界观人设', value: wv ? `本设备 override（${wv.length} 字）` : '默认 ARK_WORLDVIEW_BASE', source: wv ? 'DB per-device' : '代码常量', scope: 'per-device', effect: '下一轮对话', where: 'brain 编辑 tab' },
      { layer: 'prompt', item: 'AI 安全基座', value: `常驻 ${AI_SAFETY_BASELINE.length} 字`, source: '代码常量', scope: 'global', effect: '不可编辑（儿童安全红线）', where: '—' },
      { layer: 'prompt', item: '附加规则', value: ad ? `启用（${ad.length} 字）` : '未启用', source: 'DB per-device', scope: 'per-device', effect: '下一轮对话', where: 'brain 编辑 tab' },
      { layer: '记忆', item: '抽取开关', value: process.env.MEMORY_EXTRACT_ENABLED === '0' ? '关闭' : '开启', source: 'env MEMORY_EXTRACT_ENABLED', scope: 'global', effect: '重启生效', where: '.env' },
      { layer: '记忆', item: '抽取节流', value: '设备房每轮 / web 每 3 轮', source: '代码（custom-llm persistTurn）', scope: 'per-role', effect: '不可配', where: '—' },
      { layer: '记忆', item: '危机内容过滤', value: '写入唯一入口 addItems 拦截', source: '代码（memory-safety-filter）', scope: 'global', effect: '不可编辑（儿童安全红线）', where: '—' },
      { layer: 'LLM', item: '主对话 provider', value: chatProvider, source: 'env LLM_PROVIDER', scope: 'global', effect: '重启生效', where: '.env' },
      { layer: 'LLM', item: '记忆抽取 LLM', value: `${ex.provider} / ${ex.model}（来源 ${ex.source === 'admin' ? '后台配置' : 'env 回落'}）`, source: ex.source === 'admin' ? 'DB（后台配置卡）' : 'env', scope: 'global', effect: '热生效', where: 'brain tab 配置卡' },
    ];

    return c.json({
      ok: true, sn, bound,
      chain: { access, identity, prompt: promptLayers, data, llm },
      config_matrix,
      server_now: Date.now(),
    });
  } catch (error) {
    return c.json({ ok: false, error: '拉取隔离视图失败，请稍后重试' }, 500);
  }
});

// 全局隔离总览（2026-08-19 川哥）：所有租户一屏对账——逐台隔离健康行 + 全库不变量自检 + 24h 可靠性。
// 不变量原则：期望零违例的检查必须带 checked 计数（检查了多少对象）——「0 violations / checked 0」
// 是没执行不是通过；违例明细必须点名到 SN/账号，能直接开修。
adminDataRoute.get('/isolation-overview', (c) => {
  try {
    const devices = deviceRegistryStore.list();
    const envAllow = (process.env.DEVICE_SN_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
    const memStats = memoryItemStore.perAccountStats();
    const memByAccount = new Map(memStats.map((r) => [r.account_id, r]));
    const convoStats = conversationStore.statsByAccount();
    const PROBE = '__isolation_probe__';

    // ── 逐台租户行：每台现场跑一遍生产 resolveDeviceIdentity（防串号自检），并挂上她的数据边界 ──
    const tenants = devices.map((d) => {
      const resolved = resolveDeviceIdentity({ accountId: PROBE, role: 'parent' }, `sn-${d.sn}-0`);
      const routeMatch = d.account_id
        ? resolved?.accountId === d.account_id && resolved?.accountId !== PROBE
        : resolved === null;
      const account = d.account_id ? accountStore.findAccount(d.account_id) : null;
      return {
        sn: d.sn,
        note: d.note ?? '',
        status: d.status,
        account_id: d.account_id ?? null,
        account_nickname: account?.nickname ?? '',
        route_match: routeMatch,
        profile_exists: d.account_id ? Boolean(profileStore.getProfile(d.account_id)) : false,
        memory_active: d.account_id ? (memByAccount.get(d.account_id)?.active_n ?? 0) : 0,
        conversation_count: d.account_id ? (convoStats[d.account_id]?.count ?? 0) : 0,
        last_active_at: d.last_active_at ?? null,
        session_count: d.session_count ?? 0,
        parent_account_id: d.parent_account_id ?? null,
      };
    });

    // ── 全库不变量自检 ──
    const invariants: Array<{ key: string; label: string; checked: number; violations: number; detail: string }> = [];

    // 1. 一账号一设备：两台设备绑同一 brain 账号 = 串号的最坏形态（记忆/对话直接混线）
    const bindings = devices.filter((d) => d.account_id);
    const byAccount = new Map<string, string[]>();
    for (const d of bindings) {
      byAccount.set(d.account_id!, [...(byAccount.get(d.account_id!) ?? []), d.sn]);
    }
    const dup = [...byAccount.entries()].filter(([, sns]) => sns.length > 1);
    invariants.push({
      key: 'unique_binding',
      label: '一账号一设备（两台共绑同号 = 记忆混线）',
      checked: bindings.length,
      violations: dup.length,
      detail: dup.map(([acc, sns]) => `${acc} 被 ${sns.length} 台绑定: ${sns.join(', ')}`).join('；'),
    });

    // 2. device- 账号命名与 SN 一致（绑定既有家长账号 acct-NN 的场景不适用，跳过）
    const named = bindings.filter((d) => d.account_id!.startsWith('device-'));
    const misnamed = named.filter((d) => d.account_id !== `device-${d.sn}`);
    invariants.push({
      key: 'device_account_naming',
      label: 'device- 账号后缀与所绑 SN 一致',
      checked: named.length,
      violations: misnamed.length,
      detail: misnamed.map((d) => `${d.sn} 绑了 ${d.account_id}`).join('；'),
    });

    // 3./4. 孤儿数据：记忆/对话里的 account_id 在账号表查无此人 = 悬空数据（含 retracted，不因下架豁免）
    const orphanMem = memStats.filter((r) => !accountStore.findAccount(r.account_id));
    invariants.push({
      key: 'no_orphan_memory',
      label: '记忆无孤儿账号（每条都能落到真实账号）',
      checked: memStats.length,
      violations: orphanMem.length,
      detail: orphanMem.map((r) => `${r.account_id}（${r.total_n} 条）`).join('；'),
    });
    const convoAccounts = Object.keys(convoStats);
    const orphanConvo = convoAccounts.filter((a) => !accountStore.findAccount(a));
    invariants.push({
      key: 'no_orphan_conversation',
      label: '对话无孤儿账号',
      checked: convoAccounts.length,
      violations: orphanConvo.length,
      detail: orphanConvo.map((a) => `${a}（${convoStats[a]!.count} 条）`).join('；'),
    });

    // ── 白名单覆盖面：env 与 DB 台账的关系（兜底面多大 / disabled 压制了谁）──
    const dbSns = new Set(devices.map((d) => d.sn));
    const envOnly = envAllow.filter((sn) => !dbSns.has(sn));
    const disabledInEnv = devices.filter((d) => d.status === 'disabled' && envAllow.includes(d.sn)).map((d) => d.sn);
    const coverage = {
      db_total: devices.length,
      db_active: devices.filter((d) => d.status === 'active').length,
      db_disabled: devices.filter((d) => d.status === 'disabled').length,
      env_allow_count: envAllow.length,
      env_only_sns: envOnly, // 只在 env 不在台账：DB 坏时的兜底面，也是台账收编的 TODO
      db_disabled_suppressing_env: disabledInEnv, // DB disabled 压制 env 存量（by design，展示出来防误判）
    };

    // ── 24h 可靠性 + LLM 通道 + 全局安全常量 ──
    const traffic_24h = deviceRegistryStore.statsSince(Date.now() - 24 * 3600_000);
    const chatRaw = (process.env.LLM_PROVIDER || '').toLowerCase();
    const chatProvider = chatRaw === 'race' ? 'race（deepseek 主 + doubao 兜底）'
      : chatRaw === 'minimax' ? 'minimax'
        : chatRaw === 'deepseek' ? 'deepseek'
          : `gemini（else 默认分支：LLM_PROVIDER=${chatRaw || '未配置'}）`;
    const ex = resolveExtractLlm();

    return c.json({
      ok: true,
      tenants,
      invariants,
      coverage,
      traffic_24h,
      llm: {
        chat_provider: chatProvider,
        extract: { provider: ex.provider, model: ex.model, source: ex.source, api_key_masked: maskKey(ex.apiKey ?? '') },
      },
      safety: {
        baseline_chars: AI_SAFETY_BASELINE.length,
        crisis_filter: '写入唯一入口 addItems 拦截（memory-safety-filter）',
        extract_enabled: process.env.MEMORY_EXTRACT_ENABLED !== '0',
      },
      accounts_total: accountStore.listAccounts().length,
      server_now: Date.now(),
    });
  } catch (error) {
    return c.json({ ok: false, error: '拉取全局隔离总览失败，请稍后重试' }, 500);
  }
});

// per-device prompt 配置（Worker Brain 编辑 tab）：世界观 override + 附加规则。
// 安全基座不在配置面里——不可编辑（儿童安全红线，见 device-brain-prompt.ts）。
adminDataRoute.put('/devices/:sn/prompt-config', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cfg: { worldview_override?: string; prompt_addendum?: string } = {};
    if (body.worldview_override !== undefined) {
      if (typeof body.worldview_override !== 'string') return c.json({ ok: false, error: 'worldview_override 须为字符串' }, 400);
      if (body.worldview_override.length > 8000) return c.json({ ok: false, error: '世界观人设过长（上限 8000 字）' }, 400);
      cfg.worldview_override = body.worldview_override;
    }
    if (body.prompt_addendum !== undefined) {
      if (typeof body.prompt_addendum !== 'string') return c.json({ ok: false, error: 'prompt_addendum 须为字符串' }, 400);
      if (body.prompt_addendum.length > 4000) return c.json({ ok: false, error: '附加规则过长（上限 4000 字）' }, 400);
      cfg.prompt_addendum = body.prompt_addendum;
    }
    deviceRegistryStore.setPromptConfig(sn, cfg);
    console.log(`[admin-brain] prompt-config saved sn=${sn} override=${(cfg.worldview_override ?? device.worldview_override ?? '').length}c addendum=${(cfg.prompt_addendum ?? device.prompt_addendum ?? '').length}c`);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '保存 prompt 配置失败，请稍后重试' }, 500);
  }
});

// 孩子档案编辑（Worker Brain tab「孩子档案」区，2026-08-19）：运营台直接给设备配 nickname/birthday/gender
// ——即体验台「变量注入」面板的真数据版（这三项建档后由 assembleSystemPrompt 画像层自动注入）。
// 校验对齐家长端 ProfileSchema（profile.ts）；upsertBasics 部分更新（无档自动建）。
adminDataRoute.patch('/devices/:sn/child-profile', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    if (!device.account_id) return c.json({ ok: false, error: '该设备未开通 brain' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: { nickname?: string; birthday?: string; gender?: string } = {};
    if (body.nickname !== undefined) {
      if (typeof body.nickname !== 'string' || body.nickname.trim().length > 20) {
        return c.json({ ok: false, error: '昵称须为字符串且 ≤20 字' }, 400);
      }
      patch.nickname = body.nickname.trim();
    }
    if (body.birthday !== undefined) {
      if (typeof body.birthday !== 'string' || !/^(\d{4}-\d{2})?$/.test(body.birthday.trim())) {
        return c.json({ ok: false, error: 'birthday 须为 YYYY-MM 或空' }, 400);
      }
      patch.birthday = body.birthday.trim();
    }
    if (body.gender !== undefined) {
      if (typeof body.gender !== 'string' || body.gender.trim().length > 10) {
        return c.json({ ok: false, error: 'gender 须为字符串且 ≤10 字' }, 400);
      }
      patch.gender = body.gender.trim();
    }
    if (!Object.keys(patch).length) return c.json({ ok: false, error: '无可更新字段' }, 400);
    const profile = profileStore.upsertBasics(device.account_id, patch);
    console.log(`[admin-brain] child-profile saved sn=${sn} fields=${Object.keys(patch).join(',')}`);
    return c.json({ ok: true, profile: { nickname: profile.nickname, birthday: profile.birthday, gender: profile.gender } });
  } catch (error) {
    return c.json({ ok: false, error: '保存孩子档案失败，请稍后重试' }, 500);
  }
});

// 家长账号关联（建档下发链预留，2026-08-19）：admin 手工绑定家长账号到设备。
// R1 家长/运营否决兴趣（2026-09-03）：软撤回 retracted_by=parent，之后语音再提不升；body {value}。
adminDataRoute.post('/devices/:sn/interest-veto', async (c) => {
  const sn = c.req.param('sn').trim();
  const device = deviceRegistryStore.get(sn);
  if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
  if (!device.account_id) return c.json({ ok: false, error: '该设备未开通 brain' }, 400);
  let body: { value?: unknown } = {};
  try { body = (await c.req.json()) as { value?: unknown }; } catch { body = {}; }
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  if (!value || value.length > 40) return c.json({ ok: false, error: 'value 必填(≤40字)' }, 400);
  const vetoed = profileStore.vetoInterest(device.account_id, value);
  if (vetoed) console.log(`[admin-brain] interest vetoed sn=${sn} value=${JSON.stringify(value)}`);
  return c.json({ ok: true, vetoed });
});

// body {parent_account_id: string|null}。绑定时若设备已开通 brain 且设备账号无档、家长有档 → 同步建档。
// 小程序自助绑定走 /api/profile/bind-sn（家长 JWT），与本端点写同一列。
adminDataRoute.patch('/devices/:sn/parent', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { parent_account_id?: unknown };
    const raw = body.parent_account_id;
    if (raw !== null && typeof raw !== 'string') {
      return c.json({ ok: false, error: 'parent_account_id 须为字符串或 null' }, 400);
    }
    const parentId = typeof raw === 'string' ? raw.trim() : null;
    // P0 人格成长生命周期（codex 3.2）：换绑到不同家长≈换孩子场景，清设备账号的关系状态
    // （新孩子不继承上一名孩子的关系温度）。纯解绑(→null)不清——可能是误操作/迁移中间态，
    // 显式重建走 DELETE /devices/:sn/relation-state。
    if (
      device.parent_account_id && parentId && parentId !== device.parent_account_id && device.account_id
    ) {
      const cleared = relationStateStore.clear(device.account_id);
      stylePoolStore.clear(device.account_id);
      childInsightStore.clear(device.account_id);
      traitStore.clear(device.account_id);
      growthLedgerStore.clear(device.account_id);
      if (cleared) console.log(`[persona] 换绑清人格状态(relation/style/insight/trait/ledger) sn=${sn} account=${device.account_id}`);
    }
    let syncedProfile = false;
    if (parentId) {
      const parent = accountStore.findAccount(parentId);
      if (!parent) return c.json({ ok: false, error: `账号 ${parentId} 不存在` }, 404);
      if (parent.role === 'device') return c.json({ ok: false, error: '不能绑定设备账号为家长' }, 400);
      deviceRegistryStore.setParentAccountId(sn, parentId);
      // 建档下发：设备已开通 brain 且无档 → 从家长档同步（有档不覆盖，运营台已配的信息优先）。
      if (device.account_id && !profileStore.getProfile(device.account_id)) {
        syncedProfile = Boolean(profileStore.copyProfile(parentId, device.account_id));
      }
    } else {
      deviceRegistryStore.setParentAccountId(sn, null);
    }
    console.log(`[admin-brain] parent ${parentId ? 'bound=' + parentId : 'unbound'} sn=${sn} synced_profile=${syncedProfile}`);
    return c.json({ ok: true, parent_account_id: parentId, synced_profile: syncedProfile });
  } catch (error) {
    return c.json({ ok: false, error: '家长绑定失败，请稍后重试' }, 500);
  }
});

// ── 人格成长一站式探针（M1-M6 全链观测，川哥快速定位用）──
// 一次请求看全：开关/allowlist 命中、关系状态、注入实况（从真实 prompt 链产物抓段落，零逻辑复制）、
// 风格池、行为画像、自我叙事、值得关心的事。
adminDataRoute.get('/devices/:sn/persona-probe', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    if (!device.account_id) return c.json({ ok: false, error: '设备未开通 brain（无设备账号）' }, 400);
    const acct = device.account_id;
    const t0 = Date.now();

    // 注入实况：走真实 prompt 链（buildDeviceLayers 与 custom-llm 热路径同源），抓 persona 相关段
    const { final } = buildDeviceLayers({ accountId: acct, role: 'device' });
    const grabLine = (marker: string) => {
      const idx = final.indexOf(marker);
      if (idx === -1) return null;
      const end = final.indexOf('\n', idx);
      return final.slice(idx, end === -1 ? undefined : end);
    };
    const injection_live = {
      style_template_line: grabLine('【说话风格·家长设定'), // P0 风格模板（2026-09-01）
      relation_line: grabLine('【和这个孩子的关系·数据】'),
      state_line: grabLine('【小可当下状态·数据】'),
      narrative_line: grabLine('【小可心里的小笔记·数据】'),
      insight_line: grabLine('【对这个孩子的观察·数据】'),
      trait_line: grabLine('【小可对这个孩子的相处倾向·数据】'),
      style_line: grabLine('【过去有效的相处方式·参考】'),
      concern_line: grabLine('值得关心 "'),
    };

    const rel = relationStateStore.getState(acct);
    const view = rel ? relationStateStore.getInjectionView(acct, Date.now()) : null;
    // promise 兑现率（trust 只读代理）：probe 里并进 relation_state 供 UI 卡 1 展示
    const relWithPromise = rel
      ? (() => {
          try {
            const { items } = memoryItemStore.listByAccount(acct);
            const promises = items.filter((i) => i.type === 'promise');
            return {
              ...rel,
              promise_total: promises.length,
              promise_resolved: promises.filter((i) => i.status === 'resolved').length,
            };
          } catch {
            return { ...rel, promise_total: 0, promise_resolved: 0 };
          }
        })()
      : null;
    const styleTop = stylePoolStore.retrieve(acct, [0.5, 0.5, 0.5, 0.5], 3).map((s) => ({
      child_said: s.child_said, xiaoke_did: s.xiaoke_did,
      mass: s.mass, mass_eff: Number(s.mass_eff.toFixed(2)),
    }));
    const concerns = memoryItemStore
      .selectForInjection(acct)
      .concerns.map((cn) => ({ content: cn.content, due_text: cn.due_text, due_at: cn.due_at, created_at: cn.created_at }));

    return c.json({
      ok: true,
      account_id: acct,
      probe_ms: Date.now() - t0,
      switches: {
        track: personaTrackEnabled(acct),
        inject: personaInjectEnabled(acct),
        style: personaStyleEnabled(acct),
        insight: personaInsightEnabled(acct),
        narrative: personaNarrativeEnabled(acct),
        trait: personaTraitEnabled(acct),
        local_audio: personaLocalAudioEnabled(acct),
        allowlist_raw: process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST ?? '(未设=放开)',
      },
      local_audio: (() => {
        const laState = localAudioStore.getState(acct);
        const bySlot: Record<string, Array<{ id: string; text: string; duration_ms: number; bytes: number }>> = {};
        for (const item of localAudioStore.listActive(acct)) {
          (bySlot[item.slot] ??= []).push({ id: item.id, text: item.text, duration_ms: item.duration_ms, bytes: item.bytes });
        }
        return {
          revision: laState.revision,
          last_generated_at: laState.last_generated_at,
          gen_tier: laState.gen_tier,
          last_applied_revision: laState.last_applied_revision,
          last_applied_at: laState.last_applied_at,
          last_fetch_at: laState.last_fetch_at,
          slots: bySlot,
        };
      })(),
      trait: {
        current: traitStore.get(acct),
        // P0 风格模板后基线随档走：有模板=模板五维（回拉/漂移界的真实锚点），无=出厂
        baseline: traitStore.baselineFor(acct),
        style_template: traitStore.getTemplate(acct) ?? 'default',
        labels: TRAIT_LABELS,
        dims: TRAIT_DIMS,
      },
      ledger_count: growthLedgerStore.count(acct),
      relation_state: relWithPromise,
      injection_view: view,
      injection_live,
      style_pool: { count: stylePoolStore.count(acct), top: styleTop },
      insight: childInsightStore.get(acct),
      narrative: relationStateStore.getNarrative(acct),
      concerns,
    });
  } catch (error) {
    return c.json({ ok: false, error: `probe 失败: ${String((error as Error)?.message ?? error)}` }, 500);
  }
});

// 成长时间线（因果链方案 §3.4 视图一）：growth_ledger 倒序流，支持 module/dimension 筛选。
adminDataRoute.get('/devices/:sn/growth-events', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device?.account_id) return c.json({ ok: false, error: '设备不在台账或未开通 brain' }, 404);
    const module = c.req.query('module')?.trim() || undefined;
    const dimension = c.req.query('dimension')?.trim() || undefined;
    const limit = Number(c.req.query('limit')) || 50;
    const events = growthLedgerStore.list(device.account_id, { module, dimension, limit });
    return c.json({ ok: true, total: growthLedgerStore.count(device.account_id), events });
  } catch (error) {
    return c.json({ ok: false, error: `growth-events 失败: ${String((error as Error)?.message ?? error)}` }, 500);
  }
});

// 手动触发 M3/M6 批任务（调试即时出结果，不等每日 3 点档）。同步跑完返回。
adminDataRoute.post('/devices/:sn/persona-insight-run', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device?.account_id) return c.json({ ok: false, error: '设备不在台账或未开通 brain' }, 404);
    const acct = device.account_id;
    const insightDims = await runInsightForAccount(acct);
    const narrativeOk = await runNarrativeForAccount(acct);
    return c.json({
      ok: true,
      insight_dims: insightDims,
      narrative_updated: narrativeOk,
      insight: childInsightStore.get(acct),
      narrative: relationStateStore.getNarrative(acct),
    });
  } catch (error) {
    return c.json({ ok: false, error: `insight-run 失败: ${String((error as Error)?.message ?? error)}` }, 500);
  }
});

// 手动触发本地人格音频生成（force 跳过触发条件；联调/Canary 用，不等每日批）。同步跑完返回。
adminDataRoute.post('/devices/:sn/persona-local-audio-run', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device?.account_id) return c.json({ ok: false, error: '设备不在台账或未开通 brain' }, 404);
    const acct = device.account_id;
    if (!personaLocalAudioEnabled(acct)) {
      return c.json({ ok: false, error: '开关未开或不在 allowlist（PERSONA_LOCAL_AUDIO_ENABLED + allowlist）' }, 400);
    }
    const force = c.req.query('force') !== '0'; // 默认 force（手动就是要立即出结果）
    const result = await runLocalAudioForAccount(acct, { force });
    return c.json({ ok: true, result, state: localAudioStore.getState(acct) });
  } catch (error) {
    return c.json({ ok: false, error: `local-audio-run 失败: ${String((error as Error)?.message ?? error)}` }, 500);
  }
});

// P0 人格成长（codex 3.2 生命周期兜底）：admin 显式重置设备账号的关系状态。
// 用途：换孩子、测试数据清理、家长要求重置。物理删除（同儿童数据删除权模式）。
// 记忆白盒（2026-09-03）：抽取流水 + 已撤回/取代条目 + 记忆因果账本（profile/insight/concern 模块）
adminDataRoute.get('/devices/:sn/memory-whitebox', (c) => {
  const sn = c.req.param('sn').trim();
  const device = deviceRegistryStore.get(sn);
  if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
  if (!device.account_id) return c.json({ ok: false, error: '该设备未开通 brain' }, 400);
  const acct = device.account_id;
  const all = memoryItemStore.listByAccount(acct).items;
  const inactive = all.filter((it) => it.status !== 'active').slice(0, 15);
  const ledger = ['profile', 'insight', 'concern']
    .flatMap((m) => growthLedgerStore.list(acct, { module: m, limit: 20 }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 30);
  return c.json({ ok: true, extraction_log: extractionLogStore.list(acct, 20), inactive_items: inactive, ledger });
});

// R3（2026-09-03）：特质每日快照列表 + 退回任意一天
adminDataRoute.get('/devices/:sn/trait-snapshots', (c) => {
  const sn = c.req.param('sn').trim();
  const device = deviceRegistryStore.get(sn);
  if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
  if (!device.account_id) return c.json({ ok: false, error: '该设备未开通 brain' }, 400);
  return c.json({ ok: true, snapshots: traitStore.listSnapshots(device.account_id) });
});
adminDataRoute.post('/devices/:sn/trait-rollback', async (c) => {
  const sn = c.req.param('sn').trim();
  const device = deviceRegistryStore.get(sn);
  if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
  if (!device.account_id) return c.json({ ok: false, error: '该设备未开通 brain' }, 400);
  let body: { day?: unknown } = {};
  try { body = (await c.req.json()) as { day?: unknown }; } catch { body = {}; }
  const day = typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : '';
  if (!day) return c.json({ ok: false, error: 'day 必填(YYYY-MM-DD)' }, 400);
  const moved = traitStore.rollbackTo(device.account_id, day);
  if (moved < 0) return c.json({ ok: false, error: '该天没有快照' }, 404);
  console.log(`[admin-brain] trait rollback sn=${sn} day=${day} moved=${moved}`);
  return c.json({ ok: true, moved, trait: traitStore.get(device.account_id), template: traitStore.getTemplate(device.account_id) });
});

adminDataRoute.delete('/devices/:sn/relation-state', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    if (!device.account_id) return c.json({ ok: false, error: '设备未开通 brain（无设备账号）' }, 400);
    // scope=persona（2026-09-01）：只清五样人格状态，不动本地音频——已发布 revision 是与
    // Android 的合同冻结物（0010 G1 rev5 不可变），「重置人格记账」场景清音频=过度执行。
    // 默认(all)保留原六样语义（换孩子/儿童数据删除权场景仍需全清）。
    const scope = c.req.query('scope')?.trim() || 'all';
    const cleared = relationStateStore.clear(device.account_id);
    const styleCleared = stylePoolStore.clear(device.account_id);
    const insightCleared = childInsightStore.clear(device.account_id);
    const traitCleared = traitStore.clear(device.account_id);
    const ledgerCleared = growthLedgerStore.clear(device.account_id);
    if (scope !== 'persona') extractionLogStore.clear(device.account_id); // 全清连抽取流水一起（儿童数据删除权）
    const localAudioCleared = scope !== 'persona';
    if (localAudioCleared) {
      localAudioStore.clearAccount(device.account_id); // 第六样：本地音频条目+文件+revision 归零
    }
    // 风格模板（P0 2026-09-01）：all=换孩子场景连家长设定一起清；persona=只清成长记账，
    // 家长显式选的风格保留（家长设置≠成长数据）。
    if (scope !== 'persona') traitStore.clearTemplate(device.account_id);
    console.log(
      `[persona] admin 重置 sn=${sn} account=${device.account_id} scope=${scope} relation=${cleared} style=${styleCleared} insight=${insightCleared} trait=${traitCleared} ledger=${ledgerCleared} local_audio=${localAudioCleared ? 'cleared' : 'kept'}`,
    );
    return c.json({ ok: true, scope, cleared, style_cleared: styleCleared, insight_cleared: insightCleared, trait_cleared: traitCleared, ledger_cleared: ledgerCleared, local_audio_cleared: localAudioCleared });
  } catch (error) {
    return c.json({ ok: false, error: '重置失败，请稍后重试' }, 500);
  }
});

// ── 说话风格模板（P0 2026-09-01 风格系统方案 §四）──
// 家长/运营为设备选风格档：写 trait_template + 特质值立即置为模板五维（记账 parent_style_template），
// 弹簧回拉与漂移界随之锚定模板——成长继续在模板附近工作。default=恢复出厂。

adminDataRoute.get('/devices/:sn/style-template', (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    if (!device.account_id) return c.json({ ok: false, error: '设备未开通 brain（无设备账号）' }, 400);
    const current = traitStore.getTemplate(device.account_id);
    return c.json({
      ok: true,
      template: current ?? 'default',
      // P2 白盒：设定时刻（四问之「什么时候变的」）；无模板行=null
      set_at: traitStore.getTemplateSetAt(device.account_id),
      // 语音调档 Phase A：谁设的（parent/voice/null）
      source: traitStore.getTemplateSource(device.account_id),
      available: listStyleTemplates(),
    });
  } catch (error) {
    return c.json({ ok: false, error: '读取风格模板失败' }, 500);
  }
});

adminDataRoute.put('/devices/:sn/style-template', async (c) => {
  try {
    const sn = c.req.param('sn').trim();
    const device = deviceRegistryStore.get(sn);
    if (!device) return c.json({ ok: false, error: '设备不在台账中' }, 404);
    if (!device.account_id) return c.json({ ok: false, error: '设备未开通 brain（无设备账号）' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { template?: string };
    const key = String(body.template ?? '').trim();
    if (key !== 'default' && !getStyleTemplate(key)) {
      return c.json({ ok: false, error: `未知风格模板: ${key || '(空)'}` }, 400);
    }
    const result = traitStore.setTemplate(device.account_id, key as StyleTemplateKey | 'default', { source: 'parent' });
    console.log(`[persona] style-template set sn=${sn} account=${device.account_id} template=${result.template ?? 'default'}`);
    return c.json({ ok: true, template: result.template ?? 'default', trait: traitStore.get(device.account_id) });
  } catch (error) {
    return c.json({ ok: false, error: `设置风格模板失败: ${String((error as Error)?.message ?? error)}` }, 500);
  }
});

// ── Worker 赛马配置（2026-09-03 川哥：赛马机制后台可选可配 + 延时测试，不用每次找 cc 改 env）──
// 通道复用热词发布的 forced-command key（64.90 apply_hotwords.py 新增 race_get/race_set/race_stats/race_bench）：
// server 只做校验/安全窗口/对撞/记账；env 写入、纪律重启、健康自检与回滚全在脚本内（与热词发布同一套安全网）。
// key 永不回显（脚本只回 hint/len），也永不从 bench 载荷传（bench 用 64.90 env 里的兜底 key）。
const RACE_RW_KEYS = [
  'LLM_FALLBACK_BASE_URL', 'LLM_FALLBACK_MODEL', 'LLM_FALLBACK_THINKING', 'LLM_FALLBACK_API_KEY',
  'LLM_RACE_MAIN_GRACE_MS', 'AGENT_INSTRUCTIONS',
] as const;
type RaceRwKey = (typeof RACE_RW_KEYS)[number];
const RACE_RW_RE: Record<RaceRwKey, RegExp> = {
  LLM_FALLBACK_BASE_URL: /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._/-]*)?$/,
  LLM_FALLBACK_MODEL: /^[A-Za-z0-9._-]{2,64}$/,
  LLM_FALLBACK_THINKING: /^(?:disabled|enabled|adaptive|off)$/,
  LLM_FALLBACK_API_KEY: /^[A-Za-z0-9._-]{16,128}$/,
  LLM_RACE_MAIN_GRACE_MS: /^\d{3,4}$/,
  AGENT_INSTRUCTIONS: /^[^\r\n"'`$\\]{0,1200}$/,
};
export const RACE_BASE_PRESETS = [
  { key: 'agent_plan', label: '火山 agent plan（api/plan/v3）', url: 'https://ark.cn-beijing.volces.com/api/plan/v3' },
  { key: 'coding_plan', label: '火山 coding plan（api/coding/v3）', url: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
];
// 2026-09-03 基准（生产真 prompt 4.8k 字、HK 发起、4 次中位首字）；tier: recommended/ok/caution/unsupported
export const RACE_MODEL_CATALOG = [
  { model: 'doubao-seed-2.0-mini', tier: 'recommended', ttft_prod_ms: 787, note: '真 prompt 首字 ~710–790ms 且最稳；协议标记正确' },
  { model: 'deepseek-v4-flash', tier: 'ok', ttft_prod_ms: 784, note: '真 prompt ~780–900ms，稳（火山侧供应）' },
  { model: 'minimax-m3', tier: 'ok', ttft_prod_ms: 1003, note: '~850–1000ms，偶有 6s 长尾' },
  { model: 'deepseek-v4-pro', tier: 'ok', ttft_prod_ms: null, note: '短提示 ~1.2s，未跑真 prompt' },
  { model: 'doubao-seed-evolving', tier: 'caution', ttft_prod_ms: 814, note: '周级滚动升级=行为会漂；有 2s 尾' },
  { model: 'doubao-seed-2.0-lite', tier: 'caution', ttft_prod_ms: 1785, note: '原兜底：真 prompt 下 0.8–4.9s 大抖' },
  { model: 'doubao-seed-2.1-turbo', tier: 'caution', ttft_prod_ms: 2116, note: '真 prompt prefill 重，~2.1s 双峰' },
  { model: 'glm-5.3-flash', tier: 'unsupported', ttft_prod_ms: null, note: '思考关不掉，80 token 内零正文' },
  { model: 'glm-5.3', tier: 'unsupported', ttft_prod_ms: null, note: '同 glm-5.3-flash' },
  { model: 'kimi-k2.7-code', tier: 'unsupported', ttft_prod_ms: null, note: '思考关不掉，首字 2.2s+' },
  { model: 'kimi-k3', tier: 'unsupported', ttft_prod_ms: null, note: '排队 3.6–38s' },
];

export function validateRaceValues(raw: unknown): { ok: true; values: Partial<Record<RaceRwKey, string>> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'values 须为对象' };
  const values: Partial<Record<RaceRwKey, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(RACE_RW_KEYS as readonly string[]).includes(k)) return { ok: false, error: `键不在白名单: ${k}` };
    if (typeof v !== 'string') return { ok: false, error: `${k} 须为字符串` };
    const val = k === 'AGENT_INSTRUCTIONS' ? v.trim() : v.trim();
    if (k === 'LLM_FALLBACK_API_KEY' && val === '') continue; // 空=不改 key
    if (!RACE_RW_RE[k as RaceRwKey].test(val)) return { ok: false, error: `${k} 值不合法` };
    if (k === 'LLM_RACE_MAIN_GRACE_MS') {
      const n = Number(val);
      if (!(n >= 200 && n <= 5000)) return { ok: false, error: 'LLM_RACE_MAIN_GRACE_MS 须在 200~5000' };
    }
    values[k as RaceRwKey] = val;
  }
  if (Object.keys(values).length === 0) return { ok: false, error: '没有可写的值' };
  return { ok: true, values };
}

function brainRaceView(): Record<string, string> {
  return {
    provider: process.env.LLM_PROVIDER ?? '',
    main_model: process.env.DEEPSEEK_MODEL ?? '',
    main_base: process.env.DEEPSEEK_BASE_URL ?? '',
    fallback_model: process.env.VOLC_LLM_MODEL ?? '',
    fallback_base: process.env.VOLC_LLM_BASE_URL ?? '',
  };
}

// ── 🧩 版本与 One-shot（2026-09-13 B89 川哥：后台要看到生产版本号/说明 + One-shot 关闭回滚按钮）──
// 开关存 server 自己的 config.db runtime_flag（configStore），签发路由每请求读同一解析函数 → 改后下一次唤醒即生效，
// 不重启、不动 env。版本卡来自随 server 部署的 release.json（发版时更新；RELEASE_JSON_PATH 可改路径）。
const ONESHOT_ROLLBACK_CAVEAT =
  '开关语义（codex B87 §3 端侧源码边界）：\n' +
  '· capability → allowlist/off 是「止扩」：新签发立刻停；进行中会话不断，已签票据 ≤1h 自然过期。\n' +
  '· 老 APK（不声明能力）设备：照常普通语音，不受影响。\n' +
  '· 已升级到含迁移 APK（v271+）的设备：下一次唤醒会 first_turn_not_granted 失败，不会自动退回普通语音——' +
  '要它们回普通须端侧合法停用首句工厂或回退 APK。\n' +
  '· Worker 回滚：先等票据排空（≤1h）与活跃房结束，ordered 首句房不能派给旧 rust-worker。';
function readReleaseJson(): { ok: true; data: unknown; path: string } | { ok: false; error: string; path: string } {
  const p = resolvePath(process.cwd(), process.env.RELEASE_JSON_PATH?.trim() || 'release.json');
  try {
    return { ok: true, data: JSON.parse(readFileSync(p, 'utf8')), path: p };
  } catch (e) {
    return { ok: false, error: (e as Error).message, path: p };
  }
}
function oneshotView() {
  const r = resolveFirstTurnPolicy();
  return {
    ok: true as const,
    policy: { effective: r.policy, source: r.source, override: r.override, env: r.env, valid: FIRST_TURN_POLICIES },
    agent_name: (process.env.ONESHOT_FIRST_TURN_AGENT_NAME || '').trim() || null,
    allowlist_count: (process.env.ONESHOT_FIRST_TURN_SN_ALLOW || '').split(',').map((x) => x.trim()).filter(Boolean).length,
    release: readReleaseJson(),
    caveat: ONESHOT_ROLLBACK_CAVEAT,
  };
}
function operatorOf(c: { req: { header: (n: string) => string | undefined } }): string {
  const header = c.req.header('authorization');
  const tok = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  return (tok ? getTokenUser(tok) : undefined) ?? 'admin';
}
adminDataRoute.get('/oneshot', (c) => c.json(oneshotView()));
adminDataRoute.put('/oneshot/policy', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { policy?: unknown; note?: unknown };
  const p = typeof body.policy === 'string' ? body.policy.trim().toLowerCase() : '';
  if (!(FIRST_TURN_POLICIES as readonly string[]).includes(p))
    return c.json({ ok: false, error: `policy 必须是 ${FIRST_TURN_POLICIES.join('|')}` }, 400);
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : '';
  const by = operatorOf(c);
  const before = resolveFirstTurnPolicy();
  configStore.setFlag(FIRST_TURN_POLICY_FLAG, p, by, note);
  const after = resolveFirstTurnPolicy();
  console.log(`[admin-oneshot] policy ${before.policy}(${before.source}) → ${after.policy}(${after.source}) by=${by} note=${JSON.stringify(note)}`);
  return c.json({ ...oneshotView(), changed: before.policy !== after.policy, before: { policy: before.policy, source: before.source } });
});
adminDataRoute.delete('/oneshot/policy', (c) => {
  const by = operatorOf(c);
  const before = resolveFirstTurnPolicy();
  const removed = configStore.clearFlag(FIRST_TURN_POLICY_FLAG);
  const after = resolveFirstTurnPolicy();
  console.log(`[admin-oneshot] override cleared removed=${removed} ${before.policy}(${before.source}) → ${after.policy}(${after.source}) by=${by}`);
  return c.json({ ...oneshotView(), removed, before: { policy: before.policy, source: before.source } });
});

adminDataRoute.get('/worker-race', async (c) => {
  const r = await callHotwordChannel({ action: 'race_get' }, 20_000);
  return c.json({ ok: r.ok === true, worker: r, brain: brainRaceView(), presets: RACE_BASE_PRESETS, catalog: RACE_MODEL_CATALOG }, r.ok ? 200 : 502);
});

adminDataRoute.get('/worker-race/stats', async (c) => {
  const hours = Math.max(1, Math.min(168, Number(c.req.query('hours') || 48) || 48));
  const r = await callHotwordChannel({ action: 'race_stats', hours }, 40_000);
  return c.json(r, r.ok ? 200 : 502);
});

adminDataRoute.put('/worker-race', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { values?: unknown; force?: unknown; note?: unknown };
  const v = validateRaceValues(body.values);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  const force = body.force === true;
  if (!force) {
    const rooms = await fetchLiveKitRooms();
    if (rooms === null) return c.json({ ok: false, error: '安全窗口检查失败(LiveKit 不可达)，确认后可强制应用' }, 409);
    if (rooms.device_rooms > 0)
      return c.json({ ok: false, error: `当前有 ${rooms.device_rooms} 路设备通话，应用会中断；等待结束或强制应用`, active_rooms: rooms.device_rooms }, 409);
  }
  const t0 = Date.now();
  const r = await callHotwordChannel({ action: 'race_set', values: v.values, force }, 150_000);
  const header = c.req.header('authorization');
  const opToken = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const by = (opToken ? getTokenUser(opToken) : null) ?? 'admin';
  const keys = Object.keys(v.values).join('+');
  if (!r.ok) {
    console.error(`[admin-race] set FAILED keys=${keys} by=${by} ms=${Date.now() - t0} rolled_back=${r.rolled_back === true} recovered=${r.recovered === true}`);
    return c.json({ ok: false, error: String(r.error ?? r.reason ?? '应用失败'), detail: r }, 502);
  }
  // 对撞：非密钥键 进程生效值 === 期望值；密钥只对撞长度
  const proc = (r.proc ?? {}) as Record<string, unknown>;
  const mismatch: string[] = [];
  for (const [k, val] of Object.entries(v.values)) {
    if (k === 'LLM_FALLBACK_API_KEY') {
      const pk = proc[k] as { len?: number } | undefined;
      if (!pk || pk.len !== val.length) mismatch.push(k);
    } else if (proc[k] !== val) mismatch.push(k);
  }
  if (mismatch.length > 0) {
    console.error(`[admin-race] set 对撞失败 keys=${mismatch.join('+')}(进程生效值≠期望值)`);
    return c.json({ ok: false, error: `应用对撞失败：${mismatch.join('、')} 的进程生效值与期望不一致`, detail: r }, 502);
  }
  console.log(`[admin-race] applied keys=${keys} by=${by} force=${force} ms=${Date.now() - t0} backup=${String(r.backup ?? '')}`);
  return c.json({ ok: true, applied: r.applied, backup: r.backup, proc: r.proc });
});

adminDataRoute.post('/worker-race/bench', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    models?: unknown; runs?: unknown; prompt?: unknown; sn?: unknown; user_texts?: unknown; base?: unknown;
  };
  const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string') : [];
  if (models.length < 1 || models.length > 8) return c.json({ ok: false, error: 'models 须为 1~8 个' }, 400);
  if (models.some((m) => !RACE_RW_RE.LLM_FALLBACK_MODEL.test(m))) return c.json({ ok: false, error: '模型名不合法' }, 400);
  const runs = Math.max(1, Math.min(5, Number(body.runs) || 3));
  const userTexts = Array.isArray(body.user_texts) && body.user_texts.length
    ? body.user_texts.filter((u): u is string => typeof u === 'string' && u.trim().length > 0 && u.length <= 60).slice(0, 3)
    : ['太亮了', '给我讲一个恐龙的小知识'];
  let system = '';
  let promptLabel = 'short';
  if (body.prompt === 'device') {
    const sn = typeof body.sn === 'string' ? body.sn.trim() : '';
    const device = sn ? deviceRegistryStore.get(sn) : null;
    if (!device?.account_id) return c.json({ ok: false, error: '设备不在台账或未开通 brain' }, 400);
    // 稳态生产 prompt（世界观/安全/记忆/附加规则/设备意图协议；逐轮护栏不含），与 Worker Brain 拼接可视化同源
    system = buildDeviceLayers({ accountId: device.account_id, role: 'device' }).final;
    promptLabel = `device:${sn.slice(-4)}`;
  } else {
    system = '你是小可，一个陪孩子学习的小伙伴。用中文口语回答，一到两句话，不用列表。';
  }
  const payload: Record<string, unknown> = { action: 'race_bench', models, runs, system, user_texts: userTexts };
  if (typeof body.base === 'string' && RACE_RW_RE.LLM_FALLBACK_BASE_URL.test(body.base)) payload.base = body.base;
  const r = await callHotwordChannel(payload, 150_000);
  if (!r.ok) return c.json({ ok: false, error: String(r.error ?? 'bench 失败'), detail: r }, 502);
  return c.json({ ...r, prompt: promptLabel });
});

// ── Worker 语音链路配置（2026-09-03 晚 川哥：供应商/方案/密钥后台手动配，不再找 cc 改 env）──
// 通道同赛马（forced-command key → 64.90 apply_hotwords.py voice_get/voice_set）；只写 rust-worker.env 覆盖层
// （EnvironmentFile 末位赢），python 线 .env 只读参考。server 侧：白名单/正则/范围（后端为真防线）+ LiveKit
// 安全窗口 + 应用后对撞（非密钥比值，密钥比长度）；密钥永不回显、永不进日志。
// 供应商可选项由 worker 二进制决定：识别只有火山（stt_volc 唯一实现），合成 volc/xfyun——换别家仍要写代码。
export const VOICE_RW_KEYS = [
  'VOLC_ASR_RESOURCE_ID', 'VOLC_ASR_END_WINDOW_MS', 'VOLC_ASR_ENABLE_DDC', 'VOLC_PREFLIGHT_ENABLED',
  'VOLC_ASR_NONSTREAM_ENABLED', 'VOLC_ASR_NONSTREAM_CANARY_SN', 'VOLC_ASR_BOOSTING_TABLE_ID',
  'VOLC_APP_ID', 'VOLC_ACCESS_TOKEN', 'VOLC_ASR_API_KEY',
  'TTS_PROVIDER', 'VOLC_TTS_RESOURCE_ID', 'VOLC_TTS_SPEAKER', 'VOLC_TTS_SPEED', 'TTS_POOL_ENABLED', 'TTS_MIN_SENTENCE_LEN',
  'XFYUN_TTS_VCN', 'XFYUN_TTS_SPEED', 'XFYUN_TTS_ORAL_LEVEL', 'XFYUN_TTS_PRECONNECT',
  'XFYUN_TTS_APP_ID', 'XFYUN_TTS_API_KEY', 'XFYUN_TTS_API_SECRET',
] as const;
type VoiceRwKey = (typeof VOICE_RW_KEYS)[number];
export const VOICE_SECRET_KEYS: readonly VoiceRwKey[] = ['VOLC_APP_ID', 'VOLC_ACCESS_TOKEN', 'VOLC_ASR_API_KEY', 'XFYUN_TTS_APP_ID', 'XFYUN_TTS_API_KEY', 'XFYUN_TTS_API_SECRET'];
const VOICE_RW_RE: Record<VoiceRwKey, RegExp> = {
  VOLC_ASR_RESOURCE_ID: /^volc\.[a-z0-9_.]{3,60}$/,
  VOLC_ASR_END_WINDOW_MS: /^\d{2,4}$/,
  VOLC_ASR_ENABLE_DDC: /^[01]$/,
  VOLC_PREFLIGHT_ENABLED: /^[01]$/,
  VOLC_ASR_NONSTREAM_ENABLED: /^[01]$/,
  VOLC_ASR_NONSTREAM_CANARY_SN: /^(?:[A-Za-z0-9]{6,40}(?:,[A-Za-z0-9]{6,40})*)?$/,
  VOLC_ASR_BOOSTING_TABLE_ID: /^(?:[A-Za-z0-9-]{8,64})?$/,
  VOLC_APP_ID: /^\d{6,16}$/,
  VOLC_ACCESS_TOKEN: /^[A-Za-z0-9._-]{16,128}$/,
  VOLC_ASR_API_KEY: /^[A-Za-z0-9._-]{16,128}$/,
  TTS_PROVIDER: /^(?:volc|xfyun)$/,
  VOLC_TTS_RESOURCE_ID: /^[A-Za-z0-9._-]{3,60}$/,
  VOLC_TTS_SPEAKER: /^[A-Za-z0-9_]{4,80}$/,
  VOLC_TTS_SPEED: /^\d(?:\.\d{1,2})?$/,
  TTS_POOL_ENABLED: /^[01]$/,
  TTS_MIN_SENTENCE_LEN: /^\d{1,2}$/,
  XFYUN_TTS_VCN: /^[A-Za-z0-9_]{3,64}$/,
  XFYUN_TTS_SPEED: /^\d{1,3}$/,
  XFYUN_TTS_ORAL_LEVEL: /^(?:high|mid|low)$/,
  XFYUN_TTS_PRECONNECT: /^[01]$/,
  XFYUN_TTS_APP_ID: /^[A-Za-z0-9]{6,16}$/,
  XFYUN_TTS_API_KEY: /^[A-Za-z0-9]{16,64}$/,
  XFYUN_TTS_API_SECRET: /^[A-Za-z0-9]{16,64}$/,
};
const VOICE_RANGES: Partial<Record<VoiceRwKey, [number, number]>> = {
  VOLC_ASR_END_WINDOW_MS: [100, 2000], TTS_MIN_SENTENCE_LEN: [2, 40], XFYUN_TTS_SPEED: [0, 100], VOLC_TTS_SPEED: [0.5, 2],
};
/** 前端按此表渲染（单源在 server；前端不写死键）。type: select|toggle|number|text|secret；options 可空=自定义。 */
export const VOICE_FIELDS: Array<{ key: VoiceRwKey; group: string; label: string; type: string; hint: string; options?: Array<{ v: string; l: string }>; min?: number; max?: number; step?: number }> = [
  { key: 'VOLC_ASR_RESOURCE_ID', group: '识别（火山 Seed ASR）', label: 'ASR 资源', type: 'select', hint: '2.0（seedasr）走 X-Api-Key 鉴权，1.0（bigasr）走 App ID + Token；换代要同时确认凭据', options: [{ v: 'volc.seedasr.sauc.duration', l: '豆包 Seed ASR 2.0 流式（seedasr，现役）' }, { v: 'volc.bigasr.sauc.duration', l: '大模型 ASR 1.0 流式（bigasr）' }] },
  { key: 'VOLC_ASR_END_WINDOW_MS', group: '识别（火山 Seed ASR）', label: '判停窗（ms）', type: 'number', hint: '句末静音多久判停；越小越快也越容易切断思考停顿（火山默认 800，现役 150）', min: 100, max: 2000, step: 10 },
  { key: 'VOLC_ASR_NONSTREAM_ENABLED', group: '识别（火山 Seed ASR）', label: '二遍整段重识别', type: 'toggle', hint: '判停后用非流式模型整段重识别（bigmodel_async）；热词预算从 100 token 升到 5000 词；账单可能双倍计时长' },
  { key: 'VOLC_ASR_NONSTREAM_CANARY_SN', group: '识别（火山 Seed ASR）', label: '二遍灰度 SN', type: 'text', hint: '逗号分隔；留空=所有设备房全开（当前）' },
  { key: 'VOLC_ASR_ENABLE_DDC', group: '识别（火山 Seed ASR）', label: '语义顺滑（DDC）', type: 'toggle', hint: '删语气词/重复词；关掉会多出「嗯、那个」进 LLM' },
  { key: 'VOLC_PREFLIGHT_ENABLED', group: '识别（火山 Seed ASR）', label: '会话预连', type: 'toggle', hint: '进房即预建 ASR 连接，省首句建连时延' },
  { key: 'VOLC_ASR_BOOSTING_TABLE_ID', group: '识别（火山 Seed ASR）', label: '火山词表 ID', type: 'text', hint: '2026-08-18 实证两端点均零生效（待火山工单）；留空=不传。热词本身在「热词管理」' },
  { key: 'VOLC_APP_ID', group: '火山凭据（识别 + 合成共用）', label: 'App ID', type: 'secret', hint: '火山语音控制台应用 ID' },
  { key: 'VOLC_ACCESS_TOKEN', group: '火山凭据（识别 + 合成共用）', label: 'Access Token', type: 'secret', hint: '1.0 ASR 与火山 TTS 用；留空不改' },
  { key: 'VOLC_ASR_API_KEY', group: '火山凭据（识别 + 合成共用）', label: 'ASR API Key（2.0）', type: 'secret', hint: 'seedasr 2.0 唯一鉴权方式；留空不改' },
  { key: 'TTS_PROVIDER', group: '合成', label: '合成供应商', type: 'select', hint: 'worker 二进制内置两家；选讯飞时讯飞三项凭据必须齐全，否则启动失败会自动回滚', options: [{ v: 'xfyun', l: '讯飞（x6 超拟人，现役）' }, { v: 'volc', l: '火山 豆包 TTS' }] },
  { key: 'XFYUN_TTS_VCN', group: '合成', label: '讯飞音色', type: 'select', hint: '讯飞控制台的发音人 ID', options: [{ v: 'x6_lingxiaoxuan_pro', l: 'x6_lingxiaoxuan_pro（凌小璇，现役）' }] },
  { key: 'XFYUN_TTS_SPEED', group: '合成', label: '讯飞语速', type: 'number', hint: '0~100，50 为常速', min: 0, max: 100, step: 5 },
  { key: 'XFYUN_TTS_ORAL_LEVEL', group: '合成', label: '讯飞口语化', type: 'select', hint: '超拟人口语化程度', options: [{ v: 'high', l: 'high' }, { v: 'mid', l: 'mid（默认）' }, { v: 'low', l: 'low' }] },
  { key: 'XFYUN_TTS_PRECONNECT', group: '合成', label: '讯飞预连', type: 'toggle', hint: '首句前预建合成连接' },
  { key: 'VOLC_TTS_SPEAKER', group: '合成', label: '火山音色', type: 'select', hint: '火山 TTS 发音人；仅合成供应商=火山时生效', options: [{ v: 'zh_male_lengkugege_emo_v2_mars_bigtts', l: 'zh_male_lengkugege_emo_v2（冷酷哥哥·多情感）' }, { v: 'zh_female_tianmeixiaoyuan_moon_bigtts', l: 'zh_female_tianmeixiaoyuan（甜美小源）' }, { v: 'zh_female_vv_uranus_bigtts', l: 'zh_female_vv_uranus（二进制默认）' }] },
  { key: 'VOLC_TTS_RESOURCE_ID', group: '合成', label: '火山 TTS 资源', type: 'text', hint: '如 volc.service_type.10029（现役）' },
  { key: 'VOLC_TTS_SPEED', group: '合成', label: '火山语速比', type: 'number', hint: '0.5~2.0，1.0 常速', min: 0.5, max: 2, step: 0.1 },
  { key: 'TTS_POOL_ENABLED', group: '合成', label: '火山连接池', type: 'toggle', hint: '仅火山 TTS' },
  { key: 'TTS_MIN_SENTENCE_LEN', group: '合成', label: '最短切句字数', type: 'number', hint: 'LLM 流式文本攒到几个字才送合成；小=首音快、句子碎', min: 2, max: 40, step: 1 },
  { key: 'XFYUN_TTS_APP_ID', group: '讯飞凭据', label: 'App ID', type: 'secret', hint: '讯飞开放平台应用 ID' },
  { key: 'XFYUN_TTS_API_KEY', group: '讯飞凭据', label: 'API Key', type: 'secret', hint: '留空不改' },
  { key: 'XFYUN_TTS_API_SECRET', group: '讯飞凭据', label: 'API Secret', type: 'secret', hint: '留空不改' },
];

export function validateVoiceValues(raw: unknown): { ok: true; values: Partial<Record<VoiceRwKey, string>> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'values 须为对象' };
  const values: Partial<Record<VoiceRwKey, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(VOICE_RW_KEYS as readonly string[]).includes(k)) return { ok: false, error: `键不在白名单: ${k}` };
    if (typeof v !== 'string') return { ok: false, error: `${k} 须为字符串` };
    const key = k as VoiceRwKey;
    const val = v.trim();
    if (VOICE_SECRET_KEYS.includes(key) && val === '') continue; // 空密钥=不改
    if (!VOICE_RW_RE[key].test(val)) return { ok: false, error: `${k} 值不合法` };
    const range = VOICE_RANGES[key];
    if (range) {
      const n = Number(val);
      if (!(n >= range[0] && n <= range[1])) return { ok: false, error: `${k} 须在 ${range[0]}~${range[1]}` };
    }
    values[key] = val;
  }
  if (Object.keys(values).length === 0) return { ok: false, error: '没有可写的值' };
  return { ok: true, values };
}

adminDataRoute.get('/worker-voice', async (c) => {
  const r = await callHotwordChannel({ action: 'voice_get' }, 20_000);
  return c.json({ ok: r.ok === true, worker: r, fields: VOICE_FIELDS, secret_keys: VOICE_SECRET_KEYS }, r.ok ? 200 : 502);
});

adminDataRoute.put('/worker-voice', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { values?: unknown; force?: unknown };
  const v = validateVoiceValues(body.values);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  const force = body.force === true;
  if (!force) {
    const rooms = await fetchLiveKitRooms();
    if (rooms === null) return c.json({ ok: false, error: '安全窗口检查失败(LiveKit 不可达)，确认后可强制应用' }, 409);
    if (rooms.device_rooms > 0)
      return c.json({ ok: false, error: `当前有 ${rooms.device_rooms} 路设备通话，应用会中断；等待结束或强制应用`, active_rooms: rooms.device_rooms }, 409);
  }
  const t0 = Date.now();
  const r = await callHotwordChannel({ action: 'voice_set', values: v.values, force }, 150_000);
  const header = c.req.header('authorization');
  const opToken = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const by = (opToken ? getTokenUser(opToken) : null) ?? 'admin';
  const keys = Object.keys(v.values).join('+'); // 只记键名，值（含密钥）永不进日志
  if (!r.ok) {
    console.error(`[admin-voice] set FAILED keys=${keys} by=${by} ms=${Date.now() - t0} rolled_back=${r.rolled_back === true} recovered=${r.recovered === true}`);
    return c.json({ ok: false, error: String(r.error ?? r.reason ?? '应用失败'), detail: r }, 502);
  }
  const proc = (r.proc ?? {}) as Record<string, unknown>;
  const mismatch: string[] = [];
  for (const [k, val] of Object.entries(v.values)) {
    if (VOICE_SECRET_KEYS.includes(k as VoiceRwKey)) {
      const pk = proc[k] as { len?: number } | undefined;
      if (!pk || pk.len !== val.length) mismatch.push(k);
    } else if (proc[k] !== val) mismatch.push(k);
  }
  if (mismatch.length > 0) {
    console.error(`[admin-voice] set 对撞失败 keys=${mismatch.join('+')}(进程生效值≠期望值)`);
    return c.json({ ok: false, error: `应用对撞失败：${mismatch.join('、')} 的进程生效值与期望不一致`, detail: r }, 502);
  }
  console.log(`[admin-voice] applied keys=${keys} by=${by} force=${force} ms=${Date.now() - t0} backup=${String(r.backup ?? '')}`);
  return c.json({ ok: true, applied: r.applied, backup: r.backup, proc: r.proc });
});

// ── 记忆抽取 LLM 配置（Worker Brain tab「记忆抽取 LLM」卡，2026-08-19）──
// 全局单行配置，写入即热生效（llm-extract 每次调用经 resolveExtractLlm 取值，零重启）。
// key 纪律：GET 只回尾 4 位；PUT 不传 api_key = 保留旧值；日志绝不打 key。

function maskKey(key: string): string {
  if (!key) return '';
  return key.length >= 8 ? `****${key.slice(-4)}` : '****';
}

adminDataRoute.get('/extract-llm', (c) => {
  try {
    const admin = extractLlmStore.get();
    const live = resolveExtractLlm();
    return c.json({
      ok: true,
      config: admin
        ? { provider: admin.provider, base_url: admin.base_url, model: admin.model, api_key_masked: maskKey(admin.api_key), updated_at: admin.updated_at }
        : null,
      live: { provider: live.provider, base_url: live.baseUrl ?? '', model: live.model, source: live.source, key_configured: Boolean(live.apiKey), api_key_masked: maskKey(live.apiKey ?? '') },
      providers: EXTRACT_PROVIDERS,
    });
  } catch (error) {
    return c.json({ ok: false, error: '读取抽取 LLM 配置失败' }, 500);
  }
});

adminDataRoute.put('/extract-llm', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = typeof body.provider === 'string' ? (body.provider as ExtractProvider) : 'inherit';
    if (!EXTRACT_PROVIDERS.includes(provider)) return c.json({ ok: false, error: `provider 须为 ${EXTRACT_PROVIDERS.join('/')}` }, 400);
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) return c.json({ ok: false, error: 'base_url 须以 http(s):// 开头' }, 400);
    if (baseUrl.length > 300) return c.json({ ok: false, error: 'base_url 过长' }, 400);
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (model.length > 120) return c.json({ ok: false, error: 'model 过长' }, 400);
    const apiKey = body.api_key === undefined ? undefined : typeof body.api_key === 'string' ? body.api_key : '';
    if (apiKey !== undefined && apiKey.length > 300) return c.json({ ok: false, error: 'api_key 过长' }, 400);
    const row = extractLlmStore.set({ provider, base_url: baseUrl, model, api_key: apiKey });
    console.log(`[extract-llm] 配置已保存 provider=${row.provider} model=${row.model || '(默认)'} key=${row.api_key ? '已配' : '回落env'}（热生效）`);
    return c.json({ ok: true, config: { provider: row.provider, base_url: row.base_url, model: row.model, api_key_masked: maskKey(row.api_key), updated_at: row.updated_at } });
  } catch (error) {
    return c.json({ ok: false, error: '保存抽取 LLM 配置失败' }, 500);
  }
});

// 测试连通：用【当前生效配置】发一次最小真实请求（今日排障探针的产品化）。不落对话内容。
adminDataRoute.post('/extract-llm/test', async (c) => {
  try {
    const cfg = resolveExtractLlm();
    const t0 = Date.now();
    const raw = await callExtractionLlm('你是连通性探针，只回 JSON', '输出 {"pong":1}，只回 JSON 本身', { maxTokens: 50, timeoutMs: 15000 });
    const ms = Date.now() - t0;
    return c.json({
      ok: true,
      reachable: raw !== null,
      ms,
      provider: cfg.provider,
      model: cfg.model,
      source: cfg.source,
      sample: raw === null ? '' : raw.slice(0, 80),
    });
  } catch (error) {
    return c.json({ ok: false, error: '测试失败' }, 500);
  }
});

// admin 手动添加记忆（体验台 memory.ts POST 的 admin 版；source='admin'，confidence=1）
adminDataRoute.post('/memory/:accountId', async (c) => {
  try {
    const accountId = c.req.param('accountId').trim();
    if (!accountStore.findAccount(accountId)) {
      return c.json({ ok: false, error: '账号不存在' }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = body.type;
    const VALID = ['promise', 'event', 'emotion', 'relation', 'preference'];
    if (typeof type !== 'string' || !VALID.includes(type)) {
      return c.json({ ok: false, error: `type 须为 ${VALID.join('/')}` }, 400);
    }
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content || content.length > 60) {
      return c.json({ ok: false, error: 'content 须为 1–60 字' }, 400);
    }
    let subject = '';
    if (type === 'promise') {
      const s = typeof body.subject === 'string' && body.subject ? body.subject : 'xiaoke';
      if (s !== 'xiaoke' && s !== 'child') return c.json({ ok: false, error: 'promise subject 须为 xiaoke/child' }, 400);
      subject = s;
    } else if (type === 'relation') {
      subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 20) : '';
    }
    const dueText = typeof body.due_text === 'string' ? body.due_text.trim().slice(0, 20) : '';
    const added = memoryItemStore.addItems(accountId, [
      {
        type: type as 'promise',
        content,
        subject,
        due_text: dueText,
        source: 'admin',
        confidence: 1,
        session_id: 'admin-brain-panel',
        source_role: 'user',
      },
    ]);
    return c.json({ ok: true, added });
  } catch (error) {
    return c.json({ ok: false, error: '添加记忆失败，请稍后重试' }, 500);
  }
});

// ── worker 运行态（设备接入页的容量/资源卡）──
// 机器资源：ssh 64.90 forced-command 只读脚本（专用 key，命令锁死）；
// 接入容量：LiveKit ListRooms（twirp，jose 手签 admin token）数 sn- 前缀设备房。
// 两路各自 try-catch 降级为 null，绝不因监控拖垮管理页。
const pexecFile = promisify(execFile);

// 30s 共享缓存(2026-08-27):admin 资源卡改 60s 自动轮询后,多标签页各自轮询会成倍打 ssh——
// 缓存让并发消费方共享一次采集;失败不缓存(下个请求重试)。
let workerStatsCache: { data: Record<string, unknown>; ts: number } | null = null;
const WORKER_STATS_TTL_MS = 30_000;

async function fetchWorkerMachineStats(): Promise<Record<string, unknown> | null> {
  if (workerStatsCache && Date.now() - workerStatsCache.ts < WORKER_STATS_TTL_MS) return workerStatsCache.data;
  try {
    const { stdout } = await pexecFile(
      'ssh',
      ['-i', '/root/.ssh/worker-stats-key', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'root@64.90.13.117', 'stats'],
      { timeout: 8000 },
    );
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    workerStatsCache = { data: parsed, ts: Date.now() };
    return parsed;
  } catch {
    return null;
  }
}

async function fetchLiveKitRooms(): Promise<{ device_rooms: number; total_rooms: number } | null> {
  try {
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    const url = (process.env.LIVEKIT_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    if (!key || !secret || !url) return null;
    const token = await new SignJWT({ video: { roomList: true } })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(key)
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode(secret));
    const resp = await fetch(`${url}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as { rooms?: Array<{ name?: string }> };
    const rooms = j.rooms ?? [];
    return {
      device_rooms: rooms.filter((r) => (r.name ?? '').startsWith('sn-')).length,
      total_rooms: rooms.length,
    };
  } catch {
    return null;
  }
}

adminDataRoute.get('/worker-stats', async (c) => {
  const [machine, rooms] = await Promise.all([fetchWorkerMachineStats(), fetchLiveKitRooms()]);
  const maxJobs = machine && typeof machine.max_jobs === 'number' ? (machine.max_jobs as number) : null;
  return c.json({
    ok: true,
    machine,
    rooms,
    capacity:
      maxJobs !== null && rooms
        ? { max_jobs: maxJobs, active_total: rooms.total_rooms, remaining: Math.max(maxJobs - rooms.total_rooms, 0) }
        : null,
    ts: Date.now(),
  });
});

// Session 签发流水（按 SN 可选过滤 + offset/limit 分页；只含元数据，无任何 token）
adminDataRoute.get('/device-sessions', (c) => {
  try {
    const sn = c.req.query('sn')?.trim() || undefined;
    const rawLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
    const rawOffset = Number(c.req.query('offset') ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
    const sessions = deviceRegistryStore.listSessions(sn, limit, offset);
    const total = deviceRegistryStore.countSessions(sn);
    return c.json({ ok: true, sessions, count: sessions.length, total });
  } catch (error) {
    return c.json({ ok: false, error: '拉取流水失败，请稍后重试' }, 500);
  }
});

// 流水行级备注（测试标注「这轮是谁」）
adminDataRoute.patch('/device-sessions/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) return c.json({ ok: false, error: 'id 不合法' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
    if (typeof body.note !== 'string') return c.json({ ok: false, error: 'note 必须是字符串' }, 400);
    const updated = deviceRegistryStore.setSessionNote(id, body.note.trim());
    if (!updated) return c.json({ ok: false, error: '流水记录不存在' }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '保存备注失败，请稍后重试' }, 500);
  }
});

// Phase 1 情景记忆治理(docs/43 §4/§8 C4):家长/运营查看孩子的 typed 记忆 + 删除权。
// GET 不返回已归档情绪原文(只给条数);DELETE = 物理删除(儿童数据删除权,区别于 LLM retract 软删)。
adminDataRoute.get('/memory/:accountId', (c) => {
  try {
    const accountId = c.req.param('accountId').trim();
    if (!accountId) return c.json({ ok: false, error: 'accountId 不能为空' }, 400);
    const { items, archived_emotion_count } = memoryItemStore.listByAccount(accountId);
    return c.json({ ok: true, items, archived_emotion_count });
  } catch (error) {
    return c.json({ ok: false, error: '拉取记忆失败，请稍后重试' }, 500);
  }
});

adminDataRoute.delete('/memory/:id', (c) => {
  try {
    const id = c.req.param('id').trim();
    if (!id) return c.json({ ok: false, error: 'id 不能为空' }, 400);
    const deleted = memoryItemStore.hardDelete(id);
    if (!deleted) return c.json({ ok: false, error: '记忆不存在' }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '删除记忆失败，请稍后重试' }, 500);
  }
});

// admin 手动重置今日体验限额（内测自助，清空所有 IP 计数；鉴权走上面 use('*') 中间件）
adminDataRoute.post('/reset-quota', (c) => {
  try {
    const cleared = resetAllQuotas();
    return c.json({ ok: true, cleared });
  } catch (error) {
    return c.json({ ok: false, error: '重置限额失败，请稍后重试' }, 500);
  }
});

// ── Worker 热词管理（2026-08-18 P0；admin 专属，门控随 /hotwords 路径正则）──
// DB=编辑真源，64.90 env=运行时真源；发布链（hotword-channel → apply_hotwords.py）负责对齐，
// 回执做三方对撞（DB 期望 = env 文件 = 进程 environ）。发布会重启生产 worker：
// 安全窗口主判据 = LiveKit device rooms=0（server 侧），脚本内近 90s 活动行二道兜底（TOCTOU）。

/** 汇总页：live 现值（经通道）+ 各 kind 草稿/最新版本 + 子集警告 */
adminDataRoute.get('/hotwords', async (c) => {
  const live = await callHotwordChannel({ action: 'status' }, 15_000);
  const kinds: Record<string, unknown> = {};
  const liveWords: Record<HotwordKind, string[]> = { interrupt: [], asr: [], exit: [], device_asr: [] };
  for (const kind of HOTWORD_KINDS) {
    const envKey = KIND_TO_ENV[kind];
    const envVal = live.ok ? String((live.env as Record<string, string>)?.[envKey] ?? '') : '';
    const procVal = live.ok ? String((live.proc as Record<string, string>)?.[envKey] ?? '') : '';
    liveWords[kind] = envVal ? envVal.split(',').filter(Boolean) : [];
    kinds[kind] = {
      env_key: envKey,
      live: liveWords[kind],
      live_in_sync: envVal === procVal, // env 文件 vs 进程 environ（改了没重启会 false）
      draft: hotwordStore.draftOf(kind),
      published: hotwordStore.publishedOf(kind),
    };
  }
  const pocVal = live.ok ? String((live.poc_env as Record<string, string>)?.VOLC_ASR_HOTWORDS ?? '') : '';
  return c.json({
    ok: true,
    channel_ok: live.ok,
    channel_error: live.ok ? undefined : live.error,
    kinds,
    warnings: subsetWarnings(liveWords),
    poc_drifted: live.ok && pocVal !== (live.env as Record<string, string>)?.VOLC_ASR_HOTWORDS,
    unit_active: live.ok ? live.unit_active : null,
    recent_activity: live.ok ? live.recent_activity : null,
  });
});

/** 存草稿（编辑即覆盖；校验字符白名单/语气词黑名单/去重） */
adminDataRoute.put('/hotwords/:kind/draft', async (c) => {
  const kind = c.req.param('kind') as HotwordKind;
  if (!HOTWORD_KINDS.includes(kind)) return c.json({ ok: false, error: '未知词表类型' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { words?: unknown; note?: unknown };
  const v = validateWords(kind, body.words);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  const header = c.req.header('authorization');
  const opToken = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const by = (opToken ? getTokenUser(opToken) : null) ?? 'admin';
  const draft = hotwordStore.saveDraft(kind, v.words, by, typeof body.note === 'string' ? body.note : '');
  return c.json({ ok: true, draft });
});

adminDataRoute.delete('/hotwords/:kind/draft', (c) => {
  const kind = c.req.param('kind') as HotwordKind;
  if (!HOTWORD_KINDS.includes(kind)) return c.json({ ok: false, error: '未知词表类型' }, 400);
  hotwordStore.deleteDraft(kind);
  return c.json({ ok: true });
});

/**
 * 发布：把选中 kind 的草稿写到 64.90 并按纪律重启 worker。
 * - 退出词在列 → 必须 exit_confirmed=true（跨端合同：Android sessionExitPhrases 需 codex 同步）
 * - 安全窗口：device rooms>0 且未 force → 409
 * - drill 仅演练链路用（透传给脚本），生产前端永不发送
 */
adminDataRoute.post('/hotwords/publish', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    kinds?: unknown; force?: unknown; exit_confirmed?: unknown; drill?: unknown; note?: unknown;
  };
  const kinds = Array.isArray(body.kinds) ? (body.kinds as HotwordKind[]) : [];
  if (kinds.length === 0 || kinds.some((k) => !HOTWORD_KINDS.includes(k)))
    return c.json({ ok: false, error: 'kinds 为空或含未知类型' }, 400);
  if (kinds.includes('exit') && body.exit_confirmed !== true)
    return c.json({ ok: false, error: '退出词与 Android 逐字合同，发布前必须确认已通知 codex 同步' }, 400);

  const drafts: Partial<Record<HotwordKind, string[]>> = {};
  for (const kind of kinds) {
    const d = hotwordStore.draftOf(kind);
    if (!d) return c.json({ ok: false, error: `「${kind}」无草稿可发布` }, 400);
    drafts[kind] = d.words;
  }

  const force = body.force === true;
  if (!force) {
    const rooms = await fetchLiveKitRooms();
    if (rooms === null)
      return c.json({ ok: false, error: '安全窗口检查失败(LiveKit 不可达)，确认后可强制发布' }, 409);
    if (rooms.device_rooms > 0)
      return c.json(
        { ok: false, error: `当前有 ${rooms.device_rooms} 路设备通话，发布会中断；等待结束或强制发布`, active_rooms: rooms.device_rooms },
        409,
      );
  }

  const words: Record<string, string> = {};
  for (const kind of kinds) words[KIND_TO_ENV[kind]] = drafts[kind]!.join(',');
  const payload: Record<string, unknown> = { action: 'apply', words, force };
  if (typeof body.drill === 'string' && body.drill) payload.drill = body.drill;

  const t0 = Date.now();
  const result = await callHotwordChannel(payload, 150_000);
  const header = c.req.header('authorization');
  const opToken = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const by = (opToken ? getTokenUser(opToken) : null) ?? 'admin';

  if (!result.ok) {
    console.error(
      `[admin-hotwords] publish FAILED kinds=${kinds.join('+')} by=${by} ms=${Date.now() - t0} rolled_back=${result.rolled_back === true} recovered=${result.recovered === true}`,
    );
    return c.json({ ok: false, error: String(result.error ?? result.reason ?? '发布失败'), detail: result }, 502);
  }

  // 三方对撞：DB 期望值 vs 进程 environ 生效值（env 文件由脚本自身保证）
  const proc = (result.proc ?? {}) as Record<string, string>;
  const mismatch = kinds.filter((k) => proc[KIND_TO_ENV[k]] !== words[KIND_TO_ENV[k]]);
  if (mismatch.length > 0) {
    console.error(`[admin-hotwords] publish 对撞失败 kinds=${mismatch.join('+')}(进程生效值≠期望值)`);
    return c.json({ ok: false, error: `发布对撞失败：${mismatch.join('、')} 的进程生效值与期望不一致`, detail: result }, 502);
  }

  const versions: Record<string, number> = {};
  for (const kind of kinds) {
    const v = hotwordStore.markPublished(kind, drafts[kind]!, by, typeof body.note === 'string' ? body.note : '');
    versions[kind] = v.version;
  }
  console.log(
    `[admin-hotwords] published kinds=${kinds.join('+')} versions=${JSON.stringify(versions)} by=${by} force=${force} ms=${Date.now() - t0}`,
  );
  return c.json({ ok: true, versions, receipt: result });
});

adminDataRoute.get('/hotwords/:kind/history', (c) => {
  const kind = c.req.param('kind') as HotwordKind;
  if (!HOTWORD_KINDS.includes(kind)) return c.json({ ok: false, error: '未知词表类型' }, 400);
  return c.json({ ok: true, history: hotwordStore.history(kind) });
});

/** 回滚：取历史版本词表存为草稿（复用同一条发布链，同样有安全网与确认门） */
adminDataRoute.post('/hotwords/rollback-draft', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; version?: unknown };
  const kind = body.kind as HotwordKind;
  if (!HOTWORD_KINDS.includes(kind)) return c.json({ ok: false, error: '未知词表类型' }, 400);
  const ver = Number(body.version);
  const target = Number.isInteger(ver) ? hotwordStore.versionOf(kind, ver) : null;
  if (!target) return c.json({ ok: false, error: `找不到 ${kind} v${body.version}` }, 404);
  const header = c.req.header('authorization');
  const opToken = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const by = (opToken ? getTokenUser(opToken) : null) ?? 'admin';
  const draft = hotwordStore.saveDraft(kind, target.words, by, `回滚自 v${target.version}`);
  return c.json({ ok: true, draft });
});

/** S2-B2 设备命令词表只读（64.90 TSV=env 生效真值；编辑管线 P1） */
adminDataRoute.get('/hotwords/device-aliases', async (c) => {
  const r = await callHotwordChannel({ action: 'device_aliases' }, 15_000);
  if (!r.ok) return c.json({ ok: false, error: String(r.error ?? '读取失败') }, 502);
  const rows: Array<{ label: number; action: string; canonical: string; aliases: string[] }> = [];
  for (const line of String(r.tsv ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    if (cols.length < 3) continue;
    rows.push({
      label: Number(cols[0]),
      action: cols[1] ?? '',
      canonical: cols[2] ?? '',
      aliases: (cols[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  rows.sort((a, b) => a.label - b.label);
  return c.json({ ok: true, rows });
});

/** 衔接短语（filler）只读：manifest 透传（94 wav 的文本/桶，音频资产管线属 P1） */
adminDataRoute.get('/hotwords/fillers', async (c) => {
  const r = await callHotwordChannel({ action: 'fillers' }, 15_000);
  if (!r.ok) return c.json({ ok: false, error: String(r.error ?? '读取失败') }, 502);
  const buckets: Record<string, Array<{ file: string; text: string }>> = {};
  for (const [file, meta] of Object.entries(r.manifest as Record<string, { bucket?: string; text?: string }>)) {
    const b = meta.bucket ?? 'gen';
    (buckets[b] ??= []).push({ file, text: meta.text ?? '' });
  }
  for (const b of Object.keys(buckets)) buckets[b].sort((x, y) => x.file.localeCompare(y.file));
  return c.json({ ok: true, buckets });
});

export { adminDataRoute };

// OTA 发布管理（admin 专属，正则已含 /ota；实现在 routes/ota.ts）
adminDataRoute.route('/ota', otaAdminRoute);

// 设备运行配置（admin 专属，正则已含 /device-config；实现在 routes/device-config.ts）
adminDataRoute.route('/device-config', configAdminRoute);
