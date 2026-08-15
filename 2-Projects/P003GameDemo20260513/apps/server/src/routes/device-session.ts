import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import { validateDeviceSn } from '../device-sn.js';

/**
 * P003 S2-B1 设备 Session API（codex 联调合同：CC_S2B1_MCU_SN_TOKEN_SESSION_API_PROMPT_20260815）。
 *
 * POST /v1/device/session          设备用凭据换 LiveKit token（绑房 + TTL，无跨会话恢复）
 * POST /v1/device/session/prefetch 预热占位（不签 token——禁止把上一轮 trace 的 token 复用到下一轮）
 *
 * 身份红线：只认 MCU SN（BJP003…），ADB serial / Android ID 一律 400。
 * 鉴权：设备凭据 = 现有 AUTH_JWT_SECRET 体系签的 device JWT（kind=p003-device，绑 SN）。
 *   正式的出厂设备密钥链未就绪（BLOCKED，硬件侧），届时只换 verifyDeviceCredential 的实现。
 * 日志纪律：只记 session_id / trace_id / SN / room / 耗时 / 状态码；
 *   JWT、Authorization、密钥一律不进日志——这条被单测的敏感扫描守着。
 */

const AGENT_NAME = 'rust-worker';

// ── env 全部请求时读取（不在模块顶层快照）：测试注入与生产热调参都靠这个 ──
const cfg = () => ({
  lkUrl: process.env.LIVEKIT_URL || 'wss://voice-hk.hahaxiong.cc',
  lkKey: process.env.LIVEKIT_API_KEY || '',
  lkSecret: process.env.LIVEKIT_API_SECRET || '',
  authSecret: process.env.AUTH_JWT_SECRET || '',
  // 白名单 fail-closed：没配就一台都不放行（403），绝不默认全放
  allow: (process.env.DEVICE_SN_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  ttlS: Number(process.env.DEVICE_SESSION_TTL_S || 3600),
  rpm: Number(process.env.DEVICE_SESSION_RPM || 10),
});

// ── 限频：内存滑窗，每 SN 每 60s 最多 rpm 次（session 与 prefetch 共享额度）──
const hits = new Map<string, number[]>();
function rateLimited(sn: string, rpm: number): boolean {
  const now = Date.now();
  const arr = (hits.get(sn) || []).filter((t) => now - t < 60_000);
  if (arr.length >= rpm) {
    hits.set(sn, arr);
    return true;
  }
  arr.push(now);
  hits.set(sn, arr);
  return false;
}

// ── room 唯一性：合同定死格式 sn-<SN>-<unix_seconds>，同秒并发用逻辑秒递增保证不撞 ──
let lastRoomSec = 0;
function nextRoomSecond(): number {
  let s = Math.floor(Date.now() / 1000);
  if (s <= lastRoomSec) s = lastRoomSec + 1;
  lastRoomSec = s;
  return s;
}

// ── prefetch 占位：10 分钟过期，session 带回时仅做日志关联，不承载任何凭据 ──
const prefetches = new Map<string, { sn: string; exp: number }>();

async function verifyDeviceCredential(
  header: string | undefined,
  secret: string,
): Promise<{ sn: string } | null> {
  if (!header?.startsWith('Bearer ') || !secret) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(secret));
    if (payload.kind !== 'p003-device' || typeof payload.sub !== 'string') return null;
    return { sn: payload.sub };
  } catch {
    return null;
  }
}

/**
 * 签发后自检（合同硬要求）：解码刚签的 token，与响应字段逐项对撞。
 * 任一不一致 → throw（外层 500 拒绝交付）。宁可不交付，不交付错的。
 */
export function assertTokenMatchesResponse(
  token: string,
  resp: { identity: string; room_name: string; expires_at_ms: number },
): void {
  const c = decodeJwt(token) as Record<string, any>;
  if (c.sub !== resp.identity) throw new Error(`自检失败: sub=${c.sub} ≠ identity`);
  if (c.video?.room !== resp.room_name) throw new Error('自检失败: video.room ≠ room_name');
  const agents: Array<{ agentName?: string }> = c.roomConfig?.agents || [];
  if (!agents.some((a) => a.agentName === AGENT_NAME))
    throw new Error(`自检失败: roomConfig.agents 缺 ${AGENT_NAME}`);
  if (c.exp * 1000 !== resp.expires_at_ms) throw new Error('自检失败: exp 与 expires_at_ms 不一致');
  if (c.exp * 1000 - Date.now() < 5_000) throw new Error('自检失败: 剩余 TTL 不足 5 秒');
}

const deviceSessionRoute = new Hono();

deviceSessionRoute.post('/session', async (c) => {
  const t0 = Date.now();
  const conf = cfg();

  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ status: 'error', code: 401, message: '缺少或无效设备凭据' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'error', code: 400, message: '请求体不是合法 JSON' }, 400);
  }
  const sn = body.device_sn;
  const traceId = body.trace_id;
  const check = validateDeviceSn(sn);
  if (!check.ok) return c.json({ status: 'error', code: 400, message: check.reason }, 400);
  if (typeof traceId !== 'string' || !traceId.trim())
    return c.json({ status: 'error', code: 400, message: 'trace_id 必填' }, 400);

  if (cred.sn !== sn)
    return c.json({ status: 'error', code: 403, message: 'SN 与设备凭据不匹配' }, 403);
  if (!conf.allow.includes(sn as string))
    return c.json({ status: 'error', code: 403, message: '设备未授权' }, 403);

  if (rateLimited(sn as string, conf.rpm))
    return c.json({ status: 'error', code: 429, message: '请求过频' }, 429);

  if (!conf.lkKey || !conf.lkSecret)
    return c.json({ status: 'error', code: 503, message: '签发服务不可用' }, 503);

  const roomSec = nextRoomSecond();
  const roomName = `sn-${sn}-${roomSec}`;
  const identity = `dev-${sn}`;
  const expSec = Math.floor(Date.now() / 1000) + conf.ttlS;
  const sessionId = randomUUID();
  const prefetchId = typeof body.prefetch_id === 'string' ? body.prefetch_id : undefined;

  const token = await new SignJWT({
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
    roomConfig: { agents: [{ agentName: AGENT_NAME }] },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(conf.lkKey)
    .setSubject(identity)
    .setNotBefore(Math.floor(Date.now() / 1000) - 10)
    .setExpirationTime(expSec)
    .sign(new TextEncoder().encode(conf.lkSecret));

  const resp = {
    status: 'ok',
    server_url: conf.lkUrl,
    room_name: roomName,
    identity,
    token,
    trace_id: traceId,
    session_id: sessionId,
    expires_at_ms: expSec * 1000,
    expected_agent_name: AGENT_NAME,
  };

  try {
    assertTokenMatchesResponse(token, resp);
  } catch (e) {
    console.error(
      `[device-session] 自检拒绝交付 sn=${sn} room=${roomName} session=${sessionId}: ${(e as Error).message}`,
    );
    return c.json({ status: 'error', code: 500, message: '签发自检失败，拒绝交付' }, 500);
  }

  console.log(
    `[device-session] ok sn=${sn} room=${roomName} session=${sessionId} trace=${traceId}` +
      `${prefetchId ? ` prefetch=${prefetchId}` : ''} ttl=${conf.ttlS}s ms=${Date.now() - t0}`,
  );
  return c.json(resp);
});

deviceSessionRoute.post('/session/prefetch', async (c) => {
  const conf = cfg();
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ status: 'error', code: 401, message: '缺少或无效设备凭据' }, 401);
  if (!conf.allow.includes(cred.sn))
    return c.json({ status: 'error', code: 403, message: '设备未授权' }, 403);
  if (rateLimited(cred.sn, conf.rpm))
    return c.json({ status: 'error', code: 429, message: '请求过频' }, 429);

  // 只做占位与（将来的）资源预热；绝不提前签 token——token 永远绑当轮 trace_id
  const prefetchId = randomUUID();
  const exp = Date.now() + 10 * 60_000;
  prefetches.set(prefetchId, { sn: cred.sn, exp });
  for (const [k, v] of prefetches) if (v.exp < Date.now()) prefetches.delete(k);

  console.log(`[device-session] prefetch sn=${cred.sn} prefetch=${prefetchId}`);
  return c.json({ status: 'warming', prefetch_id: prefetchId, expires_at_ms: exp });
});

export { deviceSessionRoute };
