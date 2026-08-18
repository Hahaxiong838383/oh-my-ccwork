import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { accountStore } from '../account-store.js';
import { conversationStore } from '../conversation-store.js';
import { profileStore } from '../profile-store.js';
import { memoryItemStore } from '../memory-item-store.js';
import { canWrite, getTokenUser, isAdminRole, isValidToken } from './auth.js';
import { resetAllQuotas } from '../guard.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { validateDeviceSn } from '../device-sn.js';
import { buildDeviceLayers } from '../device-brain-prompt.js';
import {
  hotwordStore,
  validateWords,
  subsetWarnings,
  KIND_TO_ENV,
  HOTWORD_KINDS,
  type HotwordKind,
} from '../hotword-store.js';
import { callHotwordChannel } from '../hotword-channel.js';

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
  if (/\/(devices|device-sessions|worker-stats|hotwords)(?:\/|$)/.test(c.req.path) && !isAdminRole(token)) {
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
    const devices = deviceRegistryStore.list();
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

adminDataRoute.post('/devices', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { sn?: unknown; note?: unknown };
    const sn = typeof body.sn === 'string' ? body.sn.trim().toUpperCase() : '';
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const check = validateDeviceSn(sn);
    if (!check.ok) {
      return c.json({ ok: false, error: 'reason' in check ? check.reason : 'SN 不合法' }, 400);
    }
    if (deviceRegistryStore.get(sn)) {
      return c.json({ ok: false, error: '该 SN 已在台账中' }, 409);
    }
    const device = deviceRegistryStore.add(sn, note);
    return c.json({ ok: true, device });
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

    const rawSecret = process.env.AUTH_JWT_SECRET;
    if (!rawSecret) return c.json({ ok: false, error: '签发服务未配置（AUTH_JWT_SECRET）' }, 503);
    const token = await new SignJWT({ accountId, role: 'device' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('p003')
      .setAudience('kidshub')
      .setExpirationTime('365d')
      .sign(new TextEncoder().encode(rawSecret));
    console.log(`[admin-brain] opened sn=${sn} account=${accountId}`);
    return c.json({ ok: true, account_id: accountId, brain_token: token });
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
            interests: profile.interests.map((i) => ({ value: i.value })),
            preferred_address: profile.preferred_address,
            recent_emotion: profile.recent_emotion,
            game_progress: profile.game_progress.map((g) => ({ value: g.value })),
          }
        : null,
      items: items.filter((it) => it.status !== 'retracted'),
      archived_emotion_count,
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

async function fetchWorkerMachineStats(): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await pexecFile(
      'ssh',
      ['-i', '/root/.ssh/worker-stats-key', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'root@64.90.13.117', 'stats'],
      { timeout: 8000 },
    );
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
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
