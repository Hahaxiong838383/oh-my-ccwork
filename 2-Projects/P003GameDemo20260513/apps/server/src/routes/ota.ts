import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { verifyDeviceCredential } from './device-session.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { otaStore } from '../ota-store.js';
import { inspectApk } from '../apk-inspect.js';
import { ContentLastResultSchema, ContentStateSchema, pckAdminRoute, resolveContentUpdate } from './ota-pck.js';
import { pckStore } from '../pck-store.js';

/**
 * P003 Android OTA（联调合同 CC_P003_OTA_JOINT_CONTRACT_20260820 + 冻结回执 + codex 修正）。
 *
 * 设备侧（挂 /v1/device/ota，S2B1 设备凭据鉴权）：
 *   POST /check —— 版本检查 + last_result 捎带落库 + 灰度裁决 + 防降级。
 *                  2026-09-04 双 OTA 合同增量：可选 content_state / content_last_result 入参，响应恒带 content_update
 *                  （null 或 PCK 包）；APK 与 PCK 裁决/账本完全分账（ota-pck.ts）。旧客户端忽略该字段即可。
 * admin 侧（挂 /api/admin/ota，复用 admin token 体系，路径已入 admin 专属正则）：
 *   PUT  /upload?filename=  流式收 APK → aapt/apksigner 实测（**实测值为发布真值**）→ 入库草稿
 *   GET  /releases          发布列表
 *   POST /releases/:vc/publish {rollout:'all'|'sns', sns[], force?, install_hint?}
 *   POST /releases/:vc/pause
 *   DELETE /releases/:vc    （仅未发布）
 *   GET  /devices           版本分布（check 上报台账）
 *
 * 冻结校验链（上传时，任一不过即拒）：包名 = OTA_PACKAGE_NAME；证书 = OTA_CERT_SHA256；
 * versionCode 严格大于已入库最大值；APK 由 apksigner 完成签名完整性校验。
 */

const cfg = () => ({
  authSecret: process.env.AUTH_JWT_SECRET || '',
  allow: (process.env.DEVICE_SN_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  packageName: process.env.OTA_PACKAGE_NAME || 'com.futurus.p003.launcher',
  certSha256: (process.env.OTA_CERT_SHA256 || '2d370c21f5dfd553d2a796314b70925fb38adeef90864c920bbbbb12887d3522').toLowerCase(),
  otaDir: resolve(process.cwd(), process.env.OTA_DIR?.trim() || './data/ota'),
  publicBase: process.env.OTA_URL_BASE || 'https://kidshub-ai.hahaxiong.cc',
  maxUploadBytes: Number(process.env.OTA_MAX_UPLOAD_BYTES || 300 * 1024 * 1024),
  rpm: Number(process.env.OTA_CHECK_RPM || 6),
});

// ── check 限频：同 SN 每 60s ≤ rpm 次（只防端上 bug 风暴，正常 4h 周期远够）──
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

// ── 白名单语义与 device-session 一致：DB 有记录以 DB status 为准；无记录回落 env ──
function snAllowed(sn: string, allow: string[]): boolean {
  const rec = deviceRegistryStore.get(sn);
  if (rec) return rec.status === 'active';
  return allow.includes(sn);
}

const LastResultSchema = z
  .object({
    from_version_code: z.number().int().nonnegative(),
    to_version_code: z.number().int().nonnegative(),
    status: z.string().max(40),
    error: z.string().max(2048).optional().default(''),
    result_ts_ms: z.number().int().nonnegative().optional(),
  })
  .nullable()
  .optional();

const CheckSchema = z.object({
  sn: z.string().trim().min(1).max(30),
  version_code: z.number().int().nonnegative(),
  version_name: z.string().max(60).optional().default(''),
  channel: z.string().max(20).optional().default('stable'),
  last_result: LastResultSchema,
  content_state: ContentStateSchema,
  content_last_result: ContentLastResultSchema,
});

export const otaDeviceRoute = new Hono();

otaDeviceRoute.post('/check', async (c) => {
  const conf = cfg();
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ ok: false, error: 'unauthorized' }, 401);

  const parsed = CheckSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request' }, 400);
  const { sn, version_code, version_name, last_result, content_state, content_last_result } = parsed.data;

  // 凭据绑 SN 与 body SN 必须一致（防 A 设备凭据探 B 设备灰度）
  if (cred.sn !== sn) return c.json({ ok: false, error: 'sn_mismatch' }, 403);
  if (!snAllowed(sn, conf.allow)) return c.json({ ok: false, error: 'forbidden' }, 403);
  if (rateLimited(sn, conf.rpm)) return c.json({ ok: false, error: 'rate_limited' }, 429);

  // last_result 落库（错误摘要截断 512B；server 侧补收到时刻，两钟并存对账）
  let lastResultJson: string | null = null;
  if (last_result) {
    lastResultJson = JSON.stringify({
      ...last_result,
      error: (last_result.error ?? '').slice(0, 512),
      server_received_ms: Date.now(),
    });
  }
  otaStore.reportCheck(sn, version_code, version_name, lastResultJson);

  // PCK 分支（分账）：投影/流水/裁决都在 ota-pck.ts；旧客户端无 content_state → 恒 null
  const content_update = resolveContentUpdate(sn, version_code, content_state, content_last_result);

  const rel = otaStore.resolveUpdate(sn, version_code);
  if (!rel) return c.json({ ok: true, update: null, content_update });
  console.log(`[ota] offer sn=${sn} ${version_code} -> ${rel.version_code}`);
  return c.json({
    ok: true,
    content_update,
    update: {
      version_code: rel.version_code,
      version_name: rel.version_name,
      package_name: rel.package_name,
      url: `${conf.publicBase}${rel.url_path}`,
      sha256: rel.sha256,
      size_bytes: rel.size_bytes,
      // codex 回执 2026-08-20：可选字段，端上缺省仍强制内置证书；带上=显式双对撞
      cert_sha256: rel.cert_sha256,
      force: rel.force_install === 1,
      install_hint: rel.install_hint,
      notes: rel.notes,
    },
  });
});

// ────────────────────────── admin 侧 ──────────────────────────

const PublishSchema = z.object({
  rollout: z.enum(['all', 'sns']),
  sns: z.array(z.string().trim().min(1)).optional().default([]),
  force: z.boolean().optional().default(false),
  install_hint: z.enum(['idle_only', 'night_only', 'immediate']).optional().default('idle_only'),
  notes: z.string().max(2000).optional(),
});

export const otaAdminRoute = new Hono();
// PCK admin 子路由（/api/admin/ota/pck/*，admin 专属正则已覆盖 ota）
otaAdminRoute.route('/pck', pckAdminRoute);

otaAdminRoute.put('/upload', async (c) => {
  const conf = cfg();
  const filename = (c.req.query('filename') || 'upload.apk').replace(/[^A-Za-z0-9._-]/g, '_');
  const uploadNotes = (c.req.query('notes') || '').trim().slice(0, 2000);
  if (!filename.endsWith('.apk')) return c.json({ ok: false, error: 'bad_filename', message: '仅接受 .apk' }, 400);
  const body = c.req.raw.body;
  if (!body) return c.json({ ok: false, error: 'empty_body' }, 400);

  await mkdir(conf.otaDir, { recursive: true });
  const tmpPath = join(conf.otaDir, `incoming-${randomUUID()}.apk`);

  // 流式落盘 + 大小硬顶（超限中断，不整包进内存）
  let received = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > conf.maxUploadBytes) controller.error(new Error('too_large'));
      else controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body.pipeThrough(limiter) as any), createWriteStream(tmpPath));
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const msg = (err as Error).message === 'too_large' ? '文件超过大小上限' : '上传中断';
    return c.json({ ok: false, error: 'upload_failed', message: msg }, 400);
  }

  // 实测校验链（APK 本体为真值）
  let facts;
  try {
    facts = await inspectApk(tmpPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const m = (err as Error).message;
    const message = m === 'apk_tools_missing' ? '服务器缺 aapt/apksigner（部署检查项）' : `APK 解析失败: ${m.slice(0, 200)}`;
    return c.json({ ok: false, error: 'inspect_failed', message }, m === 'apk_tools_missing' ? 503 : 400);
  }

  const reject = async (message: string) => {
    await unlink(tmpPath).catch(() => {});
    console.warn(`[ota] upload rejected: ${message}`);
    return c.json({ ok: false, error: 'validation_failed', message, facts }, 400);
  };
  if (facts.package_name !== conf.packageName) {
    return reject(`包名不符: ${facts.package_name}（冻结值 ${conf.packageName}）`);
  }
  if (facts.cert_sha256 !== conf.certSha256) {
    return reject(`签名证书不符（非冻结证书）`);
  }
  const maxExisting = otaStore.maxVersionCode();
  if (facts.version_code <= maxExisting) {
    return reject(`versionCode ${facts.version_code} 不大于已入库最大值 ${maxExisting}（防降级）`);
  }

  const finalName = `p003-launcher-${facts.version_code}.apk`;
  const finalPath = join(conf.otaDir, finalName);
  await rename(tmpPath, finalPath);
  otaStore.insertRelease({
    version_code: facts.version_code,
    version_name: facts.version_name,
    package_name: facts.package_name,
    apk_path: finalPath,
    url_path: `/ota/${finalName}`,
    sha256: facts.sha256,
    size_bytes: facts.size_bytes,
    cert_sha256: facts.cert_sha256,
    force_install: 0,
    install_hint: 'idle_only',
    notes: uploadNotes,
    channel: 'stable',
    enabled: 0,
    rollout_sns: '',
  });
  console.log(`[ota] uploaded v${facts.version_code} (${facts.version_name}) sha=${facts.sha256.slice(0, 12)}…`);
  return c.json({ ok: true, release: { ...facts, url_path: `/ota/${finalName}`, enabled: 0 } });
});

otaAdminRoute.get('/releases', (c) => {
  const releases = otaStore.listReleases().map((r) => ({ ...r, apk_path: undefined }));
  return c.json({ ok: true, releases });
});

otaAdminRoute.post('/releases/:vc/publish', async (c) => {
  const vc = Number.parseInt(c.req.param('vc'), 10);
  const rel = otaStore.getRelease(vc);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  const parsed = PublishSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', message: 'rollout 须为 all 或 sns' }, 400);
  const { rollout, sns, force, install_hint, notes } = parsed.data;
  // 全量必须显式 rollout='all'；rollout='sns' 时名单不可为空（防误全量）
  if (rollout === 'sns' && sns.length === 0) {
    return c.json({ ok: false, error: 'empty_sns', message: 'rollout=sns 时名单不可为空' }, 400);
  }
  otaStore.publish(vc, rollout === 'all' ? '' : sns.join(','), force, install_hint);
  // 2026-09-07 前 notes 收了不落库（记忆 p003_ota「publish notes 不落库」坑）；不带 notes 的发布（强制/灰度切换）不清空
  if (notes !== undefined) otaStore.updateNotes(vc, notes.trim());
  console.log(`[ota] published v${vc} rollout=${rollout === 'all' ? 'ALL' : sns.join(',')} force=${force}`);
  return c.json({ ok: true, release: { ...otaStore.getRelease(vc), apk_path: undefined } });
});

otaAdminRoute.post('/releases/:vc/pause', (c) => {
  const vc = Number.parseInt(c.req.param('vc'), 10);
  if (!otaStore.pause(vc)) return c.json({ ok: false, error: 'not_found' }, 404);
  console.log(`[ota] paused v${vc}`);
  return c.json({ ok: true });
});

otaAdminRoute.delete('/releases/:vc', async (c) => {
  const vc = Number.parseInt(c.req.param('vc'), 10);
  const rel = otaStore.getRelease(vc);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  if (rel.enabled === 1) return c.json({ ok: false, error: 'still_enabled', message: '已发布版本须先暂停' }, 400);
  if (!otaStore.deleteRelease(vc)) return c.json({ ok: false, error: 'delete_failed' }, 500);
  await unlink(rel.apk_path).catch(() => {});
  return c.json({ ok: true });
});

const NotesSchema = z.object({ notes: z.string().max(2000) });
/** 更新说明：任何状态可改（已发布也能补写「更新了什么/解决了什么」）；设备 check offer 的 notes 字段同源。 */
otaAdminRoute.patch('/releases/:vc/notes', async (c) => {
  const vc = Number.parseInt(c.req.param('vc'), 10);
  if (!otaStore.getRelease(vc)) return c.json({ ok: false, error: 'not_found' }, 404);
  const parsed = NotesSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', message: '更新说明须为不超过 2000 字的文本' }, 400);
  const notes = parsed.data.notes.trim();
  otaStore.updateNotes(vc, notes);
  console.log(`[ota] notes updated v${vc} len=${notes.length}`);
  return c.json({ ok: true, release: { ...otaStore.getRelease(vc), apk_path: undefined } });
});

otaAdminRoute.get('/devices', (c) => {
  const devices = otaStore.listDeviceStatus().map((d) => ({
    ...d,
    // 2026-09-16 川哥：设备接入页人工填的备注同步到「设备版本分布」表（只读展示；台账无记录=空串）
    note: deviceRegistryStore.get(d.sn)?.note ?? '',
    // 2026-09-16 川哥：同表带当前 PCK 版本（pck_device_status.active_content_version；旧端/未上报=null）
    pck_active_version: pckStore.getDevice(d.sn)?.active_content_version ?? null,
    last_result: d.last_result_json ? JSON.parse(d.last_result_json) : null,
    last_result_json: undefined,
  }));
  return c.json({ ok: true, devices });
});
