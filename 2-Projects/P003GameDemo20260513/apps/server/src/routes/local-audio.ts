import { Hono } from 'hono';
import { verifyDeviceCredential } from './device-session.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { localAudioStore } from '../local-audio-store.js';
import { personaLocalAudioEnabled } from '../relation-state-store.js';

/**
 * 本地人格音频设备端点（合同 CODEX_P003_LOCAL_AUDIO_CONTRACT_v1.1 §3 + codex 回执 §4.1）。
 *
 * GET /manifest?applied_revision=N —— 设备凭据鉴权（sub 取 SN，同 device-config）；
 *   applied_revision 只记录（触达证据），无其他副作用。功能关/不在 allowlist =
 *   200 {enabled:false}（明确状态非错误）；schema_version=1。
 * GET /file/:id —— 归属校验（该 SN 名下条目才给，404 不区分不存在/不属于你）；
 *   ETag/If-None-Match → 304；429 必带 Retry-After（合同 §3.2，遥测线教训）。
 *
 * 抓取时机 codex 侧冻结：沪时 04:00–06:00 hash(SN+日期) 抖动 + 开机兜底 + 网络恢复兜底。
 */

/** file 限频默认值。容量算术（2026-08-28 rev5 活锁事故后立）：客户端冷同步=整套全量下载且
 *  原子应用（不完整 staging 整套丢弃重来），故默认值必须 ≥ 理论最大套（slot 枚举×每 slot 上限
 *  =14×5=70）×1.5 重试余量——单测 cap-1 锚死这条算术，枚举再扩会先翻红逼提额。
 *  事故形态：套 30→48 扩容时旧默认 30 恰好卡死冷同步（30 成功→第 31 个 429→客户端弃整套→活锁）。 */
export const LOCAL_AUDIO_FILE_RPM_DEFAULT = 120;

const cfg = () => ({
  authSecret: process.env.AUTH_JWT_SECRET || '',
  allow: (process.env.DEVICE_SN_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  manifestRpm: Number(process.env.LOCAL_AUDIO_MANIFEST_RPM || 6),
  fileRpm: Number(process.env.LOCAL_AUDIO_FILE_RPM || LOCAL_AUDIO_FILE_RPM_DEFAULT),
});

// 限频：同 SN 60s 滑窗（模式同 device-config）。file 侧合法峰值=冷同步整套全量（rev5=48 文件），见 LOCAL_AUDIO_FILE_RPM_DEFAULT 的容量算术注释
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

function snAllowed(sn: string, allow: string[]): boolean {
  const rec = deviceRegistryStore.get(sn);
  if (rec) return rec.status === 'active';
  return allow.includes(sn);
}

const DISABLED_MANIFEST = { schema_version: 1, enabled: false, delivery: 'audio', revision: 0, slots: {} } as const;

export const localAudioDeviceRoute = new Hono();

localAudioDeviceRoute.get('/manifest', async (c) => {
  const conf = cfg();
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const sn = cred.sn;
  if (!snAllowed(sn, conf.allow)) return c.json({ ok: false, error: 'forbidden' }, 403);
  if (rateLimited(`m:${sn}`, conf.manifestRpm)) {
    c.header('Retry-After', '60');
    return c.json({ ok: false, error: 'rate_limited' }, 429);
  }

  const accountId = `device-${sn}`;
  const appliedRaw = c.req.query('applied_revision');
  const applied = appliedRaw !== undefined && /^\d+$/.test(appliedRaw) ? Number(appliedRaw) : null;

  if (!personaLocalAudioEnabled(accountId)) {
    localAudioStore.recordFetch(accountId, applied, DISABLED_MANIFEST.revision);
    console.log(`[local-audio] manifest sn=${sn} enabled=false applied=${applied ?? '-'}`);
    return c.json(DISABLED_MANIFEST);
  }

  const manifest = localAudioStore.buildManifest(accountId);
  localAudioStore.recordFetch(accountId, applied, manifest.revision); // 触达流水带服务端返回的 revision（对账用）
  console.log(`[local-audio] manifest sn=${sn} revision=${manifest.revision} applied=${applied ?? '-'}`);
  return c.json(manifest);
});

localAudioDeviceRoute.get('/file/:id', async (c) => {
  const conf = cfg();
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const sn = cred.sn;
  if (!snAllowed(sn, conf.allow)) return c.json({ ok: false, error: 'forbidden' }, 403);
  if (rateLimited(`f:${sn}`, conf.fileRpm)) {
    c.header('Retry-After', '60');
    return c.json({ ok: false, error: 'rate_limited' }, 429);
  }

  const accountId = `device-${sn}`;
  const id = c.req.param('id');
  const item = localAudioStore.getItem(accountId, id);
  if (!item) return c.json({ ok: false, error: 'not_found' }, 404);

  // 验收专用 SHA 投毒（W-J5，codex W5 合同：manifest/bytes/ETag 全保持真值，仅 file 载荷污染，
  // 禁止同 revision manifest 漂移）：命中 id 时翻转数据区中间一字节返回（长度不变 → bytes 一致，
  // 设备下载后 SHA 校验必失败）。投毒态跳过 304（必须把污染体真实交出去）。测完必须删键+restart。
  const poisonHit = !!process.env.LOCAL_AUDIO_POISON_ID?.trim() && id === process.env.LOCAL_AUDIO_POISON_ID.trim();

  const etag = `"${item.sha256}"`;
  if (!poisonHit && c.req.header('if-none-match') === etag) {
    console.log(`[local-audio] file sn=${sn} id=${id} 304`);
    return c.body(null, 304, { ETag: etag });
  }
  const audio = localAudioStore.readAudio(accountId, id, item.format);
  if (!audio) {
    // DB 有行盘上无文件（异常态）：404 让设备按「弃该条整套不切换」走，下轮生成会自愈
    console.log(`[local-audio] file sn=${sn} id=${id} 盘上缺文件`);
    return c.json({ ok: false, error: 'not_found' }, 404);
  }
  let body = audio;
  if (poisonHit) {
    body = Buffer.from(audio);
    const mid = Math.min(body.length - 1, 44 + Math.floor(Math.max(0, body.length - 44) / 2));
    body[mid] = body[mid] ^ 0xff;
    console.log(`[local-audio] ⚠️ file SHA 投毒生效 sn=${sn} id=${id}`);
  }
  console.log(`[local-audio] file sn=${sn} id=${id} 200 bytes=${body.length} format=${item.format}`);
  return c.body(new Uint8Array(body), 200, {
    'Content-Type': item.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    'Content-Length': String(body.length),
    ETag: etag,
  });
});
