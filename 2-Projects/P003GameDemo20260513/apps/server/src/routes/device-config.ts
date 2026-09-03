import { Hono } from 'hono';
import { verifyDeviceCredential } from './device-session.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { validateDeviceSn } from '../device-sn.js';
import { configStore, CONFIG_KEYS, invalidValueMessage } from '../config-store.js';

/**
 * 设备运行配置（联调合同 CC_P003_POSTURE_COOLDOWN_REMOTE_CONFIG_HANDOFF_20260821 + cc 回执冻结）。
 *
 * 设备侧（挂 /v1/device/config，S2B1 设备凭据鉴权）：
 *   GET /  —— 完整快照。SN 直接取凭据 sub（零上行数据）；限频同 SN 60s 窗。
 *   同步时机（codex 侧冻结）：启动 + 网络恢复 + 30min 轮询；revision 变即整快照重应用（幂等）。
 * admin 侧（挂 /api/admin/device-config，复用 admin token 体系，路径已入 admin 专属正则）：
 *   GET    /                 总览（键注册表 + 全局值 + per-SN 覆盖列表）
 *   PUT    /global           {key, value} 设全局默认
 *   PUT    /sn/:sn           {key, value} 设 SN 覆盖（覆盖优先于全局）
 *   DELETE /sn/:sn?key=      清 SN 覆盖（回落全局/内置；tombstone 保 revision 单调）
 *
 * 校验单源：CONFIG_KEYS 注册表（store 层同一道门，route 不重复写范围）。
 */

const cfg = () => ({
  authSecret: process.env.AUTH_JWT_SECRET || '',
  allow: (process.env.DEVICE_SN_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rpm: Number(process.env.DEVICE_CONFIG_RPM || 6),
});

// ── 限频：同 SN 每 60s ≤ rpm 次（30min 轮询远够；只防端上 bug 风暴）──
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

// ── 白名单语义与 device-session/ota 一致：DB 有记录以 DB status 为准；无记录回落 env ──
function snAllowed(sn: string, allow: string[]): boolean {
  const rec = deviceRegistryStore.get(sn);
  if (rec) return rec.status === 'active';
  return allow.includes(sn);
}

export const deviceConfigRoute = new Hono();

deviceConfigRoute.get('/', async (c) => {
  const conf = cfg();
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const sn = cred.sn;
  if (!snAllowed(sn, conf.allow)) return c.json({ ok: false, error: 'forbidden' }, 403);
  if (rateLimited(sn, conf.rpm)) return c.json({ ok: false, error: 'rate_limited' }, 429);

  // 验收专用故障注入（codex 负向对撞 CC_P003_POSTURE_CONFIG_NEGATIVE_TEST_REQUEST_20260821）：
  // 配了就原样返回该 JSON（鉴权/限频保持真实，只伪造载荷）。测完必须删键+restart。
  // parse 失败显眼 500（不静默回退——配了没生效的盲区比失败更糟）。
  const override = process.env.DEVICE_CONFIG_ACCEPTANCE_OVERRIDE?.trim();
  if (override) {
    try {
      const fake = JSON.parse(override);
      console.log(`[device-config] ⚠️ 验收注入生效 sn=${sn} payload=${override.slice(0, 200)}`);
      return c.json(fake);
    } catch {
      return c.json({ ok: false, error: 'acceptance_override_invalid_json' }, 500);
    }
  }
  return c.json(configStore.effectiveSnapshot(sn));
});

// ─────────────────────────── admin ───────────────────────────

export const configAdminRoute = new Hono();

configAdminRoute.get('/', (c) => {
  return c.json({ ok: true, ...configStore.adminOverview() });
});

function parseSetBody(body: unknown): { key: string; value: unknown } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { key, value } = body as { key?: unknown; value?: unknown };
  if (typeof key !== 'string' || !(key in CONFIG_KEYS)) return null;
  return { key, value };
}

configAdminRoute.put('/global', async (c) => {
  const parsed = parseSetBody(await c.req.json().catch(() => null));
  if (!parsed) return c.json({ ok: false, error: 'unknown_key' }, 400);
  const rev = configStore.setGlobal(parsed.key, parsed.value);
  if (rev === null) return c.json({ ok: false, error: 'invalid_value', message: invalidValueMessage(parsed.key) }, 400);
  console.log(`[device-config] global ${parsed.key}=${JSON.stringify(parsed.value)} rev=${rev}`);
  return c.json({ ok: true, rev });
});

configAdminRoute.put('/sn/:sn', async (c) => {
  const sn = c.req.param('sn');
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_sn' }, 400);
  const parsed = parseSetBody(await c.req.json().catch(() => null));
  if (!parsed) return c.json({ ok: false, error: 'unknown_key' }, 400);
  const rev = configStore.setValue(sn, parsed.key, parsed.value);
  if (rev === null) return c.json({ ok: false, error: 'invalid_value', message: invalidValueMessage(parsed.key) }, 400);
  console.log(`[device-config] sn=${sn} ${parsed.key}=${JSON.stringify(parsed.value)} rev=${rev}`);
  return c.json({ ok: true, rev });
});

configAdminRoute.delete('/sn/:sn', (c) => {
  const sn = c.req.param('sn');
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_sn' }, 400);
  const key = c.req.query('key') || '';
  const rev = configStore.clearForSn(sn, key);
  if (rev === null) return c.json({ ok: false, error: 'unknown_key' }, 400);
  console.log(`[device-config] clear sn=${sn} ${key} rev=${rev}`);
  return c.json({ ok: true, rev });
});
