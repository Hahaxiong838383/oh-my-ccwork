import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import { validateDeviceSn } from '../device-sn.js';
import { deviceRegistryStore, type SessionLogEntry } from '../device-registry-store.js';
import { configStore, type RuntimeFlag } from '../config-store.js';

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

// 旧路径（= 现役生产 worker）的 agent 名。B29：产品首句 v1 不能派给它——它没有 ordered_pcm
// 代次状态机，设备发了 begin 也没人接。新能力走 cfg().firstTurnAgent 指定的独立 agent。
const AGENT_NAME = 'rust-worker';

// ── env 全部请求时读取（不在模块顶层快照）：测试注入与生产热调参都靠这个 ──
const cfg = () => ({
  lkUrl: process.env.LIVEKIT_URL || 'wss://voice-hk.hahaxiong.cc',
  lkKey: process.env.LIVEKIT_API_KEY || '',
  lkSecret: process.env.LIVEKIT_API_SECRET || '',
  authSecret: process.env.AUTH_JWT_SECRET || '',
  // B29 定向派单：产品首句 v1 专用 worker 的 agent 名。**没配 = 不签新能力**
  // （codex B29 §3：缺可用派单目标时拒签，绝不把 ordered 首句投给旧 worker）。
  firstTurnAgent: (process.env.ONESHOT_FIRST_TURN_AGENT_NAME || '').trim(),
  // 白名单 fail-closed：没配就一台都不放行（403），绝不默认全放
  allow: (process.env.DEVICE_SN_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  ttlS: Number(process.env.DEVICE_SESSION_TTL_S || 3600),
  rpm: Number(process.env.DEVICE_SESSION_RPM || 10),
  // B23 产品首句 v1（2026-09-11）：签发名单 fail-closed（空 = 全关），且客户端必须在请求 supports 里声明
  // oneshot_first_turn_v1 才签；任一不成立 = 旧 RTC 路径（metadata/响应与今天完全相同）。只看 env 名单，
  // 不走 registry（isSnAllowed 会把所有 active 设备放行，那是准入名单不是灰度名单）。
  firstTurnAllow: (process.env.ONESHOT_FIRST_TURN_SN_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // B84 发布策略（2026-09-13，V1.1 产品化——OTA 到新版 APK 即自动具备 One-shot，不再逐台加名单）：
  //   allowlist（默认 = 今天的行为）：只对 ONESHOT_FIRST_TURN_SN_ALLOW 名单内 ∧ supports 含 oneshot_first_turn_v1 的请求签
  //   capability：任何已准入设备，只要本次请求 supports **同时**含 oneshot_first_turn_v1 与 local_receipt_v1 就签
  //   off：全局暂停（运维回滚开关）——一台都不签，已签发票据按 TTL 自然过期，不切断进行中的会话
  //   其它值 = 配置错 → 按 allowlist 处理并 console.warn（fail-closed 到最窄的可用形态，不静默放宽）
  // 三档都仍受 B29 第三条件约束：没配派单目标（ONESHOT_FIRST_TURN_AGENT_NAME）就不签。
  // B89（2026-09-13）：后台覆盖值（config.db runtime_flag）> env > 内置 allowlist；解析在 resolveFirstTurnPolicy，
  // 后台 GET 与签发用同一函数，不会出现「后台显示 A、实际签 B」。
  ...(() => {
    const r = resolveFirstTurnPolicy();
    return { firstTurnPolicy: r.policy, firstTurnPolicySource: r.source };
  })(),
});

/** B23：产品首句合同（响应 `contract` 与 agent metadata 同源，自检对撞）。 */
export const FIRST_TURN_CONTRACT = {
  input_mode: 'ordered_pcm',
  oneshot_first_turn: 'v1',
  local_receipt: 'v1',
  history_topic: 'p003.audio.history.v1',
  worker_capabilities: ['android_local_receipt_v1', 'oneshot_first_turn_v1'],
} as const;
export const FIRST_TURN_SUPPORT_TAG = 'oneshot_first_turn_v1';

// ── B84 发布策略：纯函数，单测锁矩阵 ──
export type FirstTurnPolicy = 'allowlist' | 'capability' | 'off';
/** capability 档要求客户端**同时**声明的两项能力（codex B84 §5.2；v270 起客户端两项一起发）。 */
export const FIRST_TURN_REQUIRED_SUPPORTS = ['oneshot_first_turn_v1', 'local_receipt_v1'] as const;
const warnedPolicy = new Set<string>();
export function normalizeFirstTurnPolicy(raw: string | undefined): FirstTurnPolicy {
  const v = (raw ?? 'allowlist').trim().toLowerCase();
  if (v === 'allowlist' || v === 'capability' || v === 'off') return v;
  // 非法值只告警一次（每个不同的错值一次），避免每请求刷屏；行为收缩到 allowlist，绝不放宽
  if (!warnedPolicy.has(v)) {
    warnedPolicy.add(v);
    console.warn(`[device-session] ONESHOT_FIRST_TURN_POLICY=${JSON.stringify(raw)} 非法，按 allowlist 处理（合法值 allowlist|capability|off）`);
  }
  return 'allowlist';
}
/**
 * 是否具备签产品首句合同的资格（不含 B29 派单目标条件，那条在调用点另判）：
 *   off        → 永不
 *   capability → supports 同时含两项能力即可，不看 SN 名单（准入已由 isSnAllowed 判过）
 *   allowlist  → SN 在灰度名单 ∧ supports 含 oneshot_first_turn_v1（= B23/B29 至今的行为，逐字不变）
 */
export function firstTurnEligibleBy(policy: FirstTurnPolicy, allow: readonly string[], sn: string, supports: readonly string[]): boolean {
  switch (policy) {
    case 'off':
      return false;
    case 'capability':
      return FIRST_TURN_REQUIRED_SUPPORTS.every((t) => supports.includes(t));
    case 'allowlist':
      return allow.includes(sn) && supports.includes(FIRST_TURN_SUPPORT_TAG);
  }
}
/** B89：后台覆盖开关的键名（config.db `runtime_flag`），值域 = FIRST_TURN_POLICIES。 */
export const FIRST_TURN_POLICY_FLAG = 'oneshot_first_turn_policy';
export const FIRST_TURN_POLICIES = ['capability', 'allowlist', 'off'] as const;
export type FirstTurnPolicySource = 'override' | 'env' | 'default';
const warnedFlag = new Set<string>();
/**
 * 生效策略的唯一解析点：后台覆盖（合法值）> env（经 normalize，非法→allowlist+warn）> 内置 allowlist。
 * 覆盖值非法（只可能来自手工改库；后台 PUT 会校验）→ 忽略覆盖、告警一次、按 env 走，绝不放宽。
 * DB 读失败 → 告警并按 env 走（DB 坏了不断签发）。
 */
export function resolveFirstTurnPolicy(): {
  policy: FirstTurnPolicy;
  source: FirstTurnPolicySource;
  override: RuntimeFlag | null;
  env: string | null;
} {
  let override: RuntimeFlag | null = null;
  try {
    override = configStore.getFlag(FIRST_TURN_POLICY_FLAG);
  } catch (e) {
    console.error(`[device-session] runtime_flag 读取失败，回落 env: ${(e as Error).message}`);
  }
  const envRaw = (process.env.ONESHOT_FIRST_TURN_POLICY ?? '').trim() || null;
  if (override) {
    const v = override.value.trim().toLowerCase();
    if ((FIRST_TURN_POLICIES as readonly string[]).includes(v)) {
      return { policy: v as FirstTurnPolicy, source: 'override', override, env: envRaw };
    }
    if (!warnedFlag.has(v)) {
      warnedFlag.add(v);
      console.warn(`[device-session] runtime_flag ${FIRST_TURN_POLICY_FLAG}=${JSON.stringify(override.value)} 非法，忽略覆盖按 env 处理（合法值 ${FIRST_TURN_POLICIES.join('|')}）`);
    }
  }
  if (envRaw !== null) return { policy: normalizeFirstTurnPolicy(envRaw), source: 'env', override, env: envRaw };
  return { policy: 'allowlist', source: 'default', override, env: null };
}
/** 日志用：只放行 `[a-z0-9_]` 组成的能力名，其它形态一律打成 `?`——防客户端把 token 样的串塞进 supports 混进日志。 */
function supportsForLog(supports: readonly string[]): string {
  if (supports.length === 0) return '-';
  return supports.map((s) => (/^[a-z0-9_]{1,64}$/.test(s) ? s : '?')).join('|');
}

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

/**
 * 白名单判定（运营台设备接入 tab 的接线点）：
 *   DB 有台账记录 → 以其 status 为准（active 放行 / disabled 拒绝，可压制 env 存量）；
 *   DB 无记录或查询异常 → 回落 env DEVICE_SN_ALLOW（存量真机兜底，DB 坏了也不断线）。
 */
function isSnAllowed(sn: string, envAllow: string[]): boolean {
  try {
    const dbStatus = deviceRegistryStore.statusOf(sn);
    if (dbStatus !== null) return dbStatus === 'active';
  } catch (e) {
    console.error(`[device-session] registry 查询失败，回落 env 白名单: ${(e as Error).message}`);
  }
  return envAllow.includes(sn);
}

/** 流水落库（只记凭据验证通过后的事件；失败不影响主流程但必须留痕，不静默吞）。 */
function logQuiet(entry: SessionLogEntry): void {
  try {
    deviceRegistryStore.logSession(entry);
  } catch (e) {
    console.error(`[device-session] 流水落库失败(不影响签发): ${(e as Error).message}`);
  }
}

export async function verifyDeviceCredential(
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
  resp: {
    identity: string;
    room_name: string;
    expires_at_ms: number;
    trace_id?: string;
    expected_agent_name?: string;
    contract?: { input_mode: string; oneshot_first_turn: string; local_receipt: string } | null;
  },
): void {
  const c = decodeJwt(token) as Record<string, any>;
  if (c.sub !== resp.identity) throw new Error(`自检失败: sub=${c.sub} ≠ identity`);
  if (c.video?.room !== resp.room_name) throw new Error('自检失败: video.room ≠ room_name');
  const agents: Array<{ agentName?: string; metadata?: string }> = c.roomConfig?.agents || [];
  // B29：拿**响应里的** expected_agent_name 去 JWT 里找，而不是两边各自对同一个常量
  // （那样实现和守护共用一个参数，改错了两边一起错=双恒绿）。缺该字段时退回旧常量兼容老调用。
  const wantAgent = resp.expected_agent_name ?? AGENT_NAME;
  if (agents.length !== 1) throw new Error(`自检失败: roomConfig.agents 应恰好 1 项，实为 ${agents.length}`);
  const agent = agents.find((a) => a.agentName === wantAgent);
  if (!agent) throw new Error(`自检失败: JWT agentName=${agents[0]?.agentName} ≠ 响应 expected_agent_name=${wantAgent}`);
  // input_ready 合同：metadata 的 trace 必须与响应 trace_id 同值（worker 侧会拿它绑事件）
  if (resp.trace_id !== undefined) {
    let metaTrace: unknown;
    try {
      metaTrace = JSON.parse(agent.metadata ?? '{}').trace_id;
    } catch {
      throw new Error('自检失败: agents[0].metadata 不是合法 JSON');
    }
    if (metaTrace !== resp.trace_id)
      throw new Error('自检失败: agents metadata trace_id ≠ 响应 trace_id');
  }
  // B23：响应 contract 与签进 token 的 metadata 三字段同源；旧路径 metadata 必须不含这三键
  if (resp.contract !== undefined) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(agent.metadata ?? '{}');
    } catch {
      throw new Error('自检失败: agents[0].metadata 不是合法 JSON');
    }
    const keys = ['input_mode', 'oneshot_first_turn', 'local_receipt'] as const;
    if (resp.contract) {
      for (const k of keys)
        if (meta[k] !== resp.contract[k]) throw new Error(`自检失败: metadata.${k} ≠ 响应 contract.${k}`);
    } else {
      for (const k of keys) if (k in meta) throw new Error(`自检失败: 旧路径 metadata 不得含 ${k}`);
    }
  }
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
  // B23：客户端能力声明（可选；非数组/非字符串项忽略；上限 16 项 × 64 字符）
  const supports: string[] = Array.isArray(body.supports)
    ? (body.supports as unknown[]).filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(0, 16)
    : [];

  if (cred.sn !== sn) {
    logQuiet({ sn: cred.sn, room: '', session_id: '', trace_id: traceId, status: 'rejected_403', ttl_s: 0, ms: Date.now() - t0 });
    return c.json({ status: 'error', code: 403, message: 'SN 与设备凭据不匹配' }, 403);
  }
  if (!isSnAllowed(sn as string, conf.allow)) {
    logQuiet({ sn: sn as string, room: '', session_id: '', trace_id: traceId, status: 'rejected_403', ttl_s: 0, ms: Date.now() - t0 });
    return c.json({ status: 'error', code: 403, message: '设备未授权' }, 403);
  }

  if (rateLimited(sn as string, conf.rpm)) {
    logQuiet({ sn: sn as string, room: '', session_id: '', trace_id: traceId, status: 'rejected_429', ttl_s: 0, ms: Date.now() - t0 });
    return c.json({ status: 'error', code: 429, message: '请求过频' }, 429);
  }

  if (!conf.lkKey || !conf.lkSecret)
    return c.json({ status: 'error', code: 503, message: '签发服务不可用' }, 503);

  // B23/B84：资格由发布策略定（allowlist = 灰度名单 ∧ 声明；capability = 双能力声明即可；off = 全停）。
  // 回滚 = ONESHOT_FIRST_TURN_POLICY=off（或退回 allowlist）+ pm2 restart；已签票据按 TTL 过期，不切断会话。
  // B29 第三个条件不随策略放宽：必须有定向派单目标。没有就**退回旧路径**（contract:null + 旧 agent），
  // 不签一个会被投给旧 worker 的空头合同——那样设备会发 begin 然后永远等不到 ack。
  const firstTurnEligible = firstTurnEligibleBy(conf.firstTurnPolicy, conf.firstTurnAllow, sn as string, supports);
  const firstTurn = firstTurnEligible && conf.firstTurnAgent !== '';
  // 本次派单目标：签了新合同 → 专用 agent；否则旧 agent。**JWT / 响应 / 自检三处同用这一个值。**
  const agentName = firstTurn ? conf.firstTurnAgent : AGENT_NAME;
  const contract = firstTurn ? { ...FIRST_TURN_CONTRACT, worker_capabilities: [...FIRST_TURN_CONTRACT.worker_capabilities] } : null;

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
    // agents[0].metadata：input_ready 合同（codex 冻结 2026-08-18）——activeTraceId 经
    // LiveKit 建房派单透传至 job.metadata，worker 进房前即持有会话级 trace 绑定，
    // 不依赖设备侧 payload 自述（可伪造）。
    roomConfig: {
      agents: [
        {
          agentName,
          // issue_ts_ms：签发时刻毫秒级（READY_LATENCY 合同 2026-08-18）——旧口径用
          // room 名尾秒(秒级)算 issue_to_assignment，自带 ±1s 量化噪声；worker 优先取此值。
          metadata: JSON.stringify({
            trace_id: traceId,
            session_id: sessionId,
            issue_ts_ms: Date.now(),
            // B23：产品首句合同三字段只在签了 contract 时出现（worker 只认这里，不认设备自述）
            ...(contract
              ? { input_mode: contract.input_mode, oneshot_first_turn: contract.oneshot_first_turn, local_receipt: contract.local_receipt }
              : {}),
          }),
        },
      ],
    },
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
    expected_agent_name: agentName,
    // B23：null = 旧 RTC 路径；对象 = 产品首句合同（与 metadata 同源，自检对撞）
    contract,
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
    `[device-session] ok sn=${sn} room=${roomName} session=${sessionId} trace=${traceId} contract=${contract ? 'first_turn_v1' : '-'}` +
      // B84：policy 与 supports 进日志——旧/新客户端各走哪条路径、为什么，事后能从这一行对账
      ` policy=${conf.firstTurnPolicy} policy_src=${conf.firstTurnPolicySource} supports=${supportsForLog(supports)}` +
      `${prefetchId ? ` prefetch=${prefetchId}` : ''} ttl=${conf.ttlS}s ms=${Date.now() - t0}`,
  );
  logQuiet({ sn: sn as string, room: roomName, session_id: sessionId, trace_id: traceId, status: 'ok', ttl_s: conf.ttlS, ms: Date.now() - t0 });
  return c.json(resp);
});

deviceSessionRoute.post('/session/prefetch', async (c) => {
  const conf = cfg();
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ status: 'error', code: 401, message: '缺少或无效设备凭据' }, 401);
  if (!isSnAllowed(cred.sn, conf.allow)) {
    logQuiet({ sn: cred.sn, room: '', session_id: '', trace_id: '', status: 'rejected_403', ttl_s: 0, ms: 0 });
    return c.json({ status: 'error', code: 403, message: '设备未授权' }, 403);
  }
  if (rateLimited(cred.sn, conf.rpm)) {
    logQuiet({ sn: cred.sn, room: '', session_id: '', trace_id: '', status: 'rejected_429', ttl_s: 0, ms: 0 });
    return c.json({ status: 'error', code: 429, message: '请求过频' }, 429);
  }

  // 只做占位与（将来的）资源预热；绝不提前签 token——token 永远绑当轮 trace_id
  const prefetchId = randomUUID();
  const exp = Date.now() + 10 * 60_000;
  prefetches.set(prefetchId, { sn: cred.sn, exp });
  for (const [k, v] of prefetches) if (v.exp < Date.now()) prefetches.delete(k);

  console.log(`[device-session] prefetch sn=${cred.sn} prefetch=${prefetchId}`);
  logQuiet({ sn: cred.sn, room: '', session_id: prefetchId, trace_id: '', status: 'prefetch', ttl_s: 0, ms: 0 });
  return c.json({ status: 'warming', prefetch_id: prefetchId, expires_at_ms: exp });
});

export { deviceSessionRoute };
