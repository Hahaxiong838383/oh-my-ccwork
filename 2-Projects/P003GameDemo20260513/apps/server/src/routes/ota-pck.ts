import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { verifyDeviceCredential } from './device-session.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { pckStore, parseSns, PCK_STAGES, type PckRelease } from '../pck-store.js';
import { inspectPck, PckInspectError, pckMaxBytes, sha256File } from '../pck-inspect.js';

/**
 * PCK（Godot 非执行内容）OTA——双 OTA 合同 CODEX_P003_APK_PCK_DUAL_OTA_SERVER_CONTRACT_20260903 + CC J0 答复。
 *
 * 设备侧：
 *   POST /v1/device/ota/check 的增量由 resolveContentUpdate() 提供（ota.ts 调用）：content_state 落投影、
 *        content_last_result 追流水（双钟）、八条 eligibility 裁决 → content_update | null（原因进 ledger）。
 *   GET/HEAD /v1/device/ota/content/files/<sha256>.pck（挂 pckDeviceRoute）：Bearer + Range；
 *        文件名只认 64 位小写 hex；draft 404 / revoked 410 / published|paused 可读（暂停只停新 offer，防半包风暴）；
 *        PCK_SERVE_MODE=xaccel → 回 X-Accel-Redirect 交 nginx（Range/206/限速由 nginx 保证）；direct → Node 自己流式 Range。
 * admin 侧（挂 /api/admin/ota/pck，admin 专属正则已覆盖 ota）：
 *   PUT  /upload?filename=&content_version=&product_models=&min_launcher_version_code=&notes=   流式收包→实测→草稿
 *   GET  /releases · PATCH /releases/:id（草稿元数据）· POST /releases/:id/publish|pause|resume|revoke|rollback · DELETE /releases/:id
 *   GET  /devices · GET /devices/:sn/log · POST /devices/:sn/freeze
 */

export const PCK_CONTENT_ID = 'g1-content';
export const PCK_ACTIVATION_POLICY = 'next_idle_reboot';
export const PCK_ASSET_PREFIX = 'v1/device/ota/content/files/'; // 同源相对路径，不带前导 /（合同 §5）

const cfg = () => ({
  authSecret: process.env.AUTH_JWT_SECRET || '',
  allow: (process.env.DEVICE_SN_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
  pckDir: resolve(process.cwd(), process.env.OTA_DIR?.trim() || './data/ota', 'pck'),
  serveMode: (process.env.PCK_SERVE_MODE || 'direct') === 'xaccel' ? 'xaccel' : 'direct',
  xaccelPrefix: process.env.PCK_XACCEL_PREFIX || '/_pck_internal/',
});

function snAllowed(sn: string, allow: string[]): boolean {
  const rec = deviceRegistryStore.get(sn);
  if (rec) return rec.status === 'active';
  return allow.includes(sn);
}

const jsonArr = (s: string): string[] => {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
};

// ───────────────────────── 设备 check 增量 ─────────────────────────

export const ContentStateSchema = z
  .object({
    schema_version: z.number().int().optional().default(1),
    content_id: z.string().max(64).optional().default(PCK_CONTENT_ID),
    product_model: z.string().max(64).optional().default(''),
    active_content_version: z.string().max(64).nullable().optional().default(null),
    pending_content_version: z.string().max(64).nullable().optional().default(null),
    activation_state: z.string().max(32).optional().default(''),
    active_sha256: z.string().max(64).nullable().optional().default(null),
  })
  .nullable()
  .optional();

export const ContentLastResultSchema = z
  .object({
    from_content_version: z.string().max(64).nullable().optional().default(''),
    to_content_version: z.string().max(64).nullable().optional().default(''),
    stage: z.string().max(32),
    status: z.string().max(32),
    error_code: z.string().max(64).optional().default(''),
    result_ts_ms: z.number().int().nonnegative().optional(),
  })
  .nullable()
  .optional();

export type ContentState = NonNullable<z.infer<typeof ContentStateSchema>>;
export type ContentLastResult = NonNullable<z.infer<typeof ContentLastResultSchema>>;

export type ContentUpdate = {
  schema_version: 1;
  content_id: string;
  content_version: string;
  product_models: string[];
  min_launcher_version_code: number;
  asset_name: string;
  length: number;
  sha256: string;
  required_resources: string[];
  activation_policy: typeof PCK_ACTIVATION_POLICY;
  force: boolean;
  release_notes: string[];
};

export function toContentUpdate(r: PckRelease): ContentUpdate {
  return {
    schema_version: 1,
    content_id: r.content_id,
    content_version: r.content_version,
    product_models: jsonArr(r.product_models),
    min_launcher_version_code: r.min_launcher_version_code,
    asset_name: `${PCK_ASSET_PREFIX}${r.sha256}.pck`,
    length: r.length,
    sha256: r.sha256,
    required_resources: jsonArr(r.required_resources),
    activation_policy: PCK_ACTIVATION_POLICY,
    force: r.force === 1,
    release_notes: jsonArr(r.release_notes),
  };
}

/**
 * check 的 PCK 分支。返回 content_update（可 null）。副作用：投影/流水/决策原因。
 * 旧客户端（无 content_state）：只 touch 投影，恒 null，不影响 APK。
 */
export function resolveContentUpdate(sn: string, launcherVersionCode: number, state: ContentState | null | undefined, last: ContentLastResult | null | undefined): ContentUpdate | null {
  if (last) {
    const stage = PCK_STAGES.includes(last.stage as never) ? last.stage : 'unknown';
    pckStore.recordResult(sn, {
      content_id: state?.content_id ?? PCK_CONTENT_ID,
      from_version: last.from_content_version ?? '',
      to_version: last.to_content_version ?? '',
      stage,
      status: last.status,
      error_code: (last.error_code ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64),
      result_ts_ms: last.result_ts_ms ?? null,
    });
    console.log(`[pck] report sn=…${sn.slice(-4)} ${last.from_content_version ?? ''}→${last.to_content_version ?? ''} ${stage}/${last.status}${last.error_code ? ' ' + last.error_code : ''}`);
  }
  if (!state) {
    pckStore.touchLegacy(sn, launcherVersionCode);
    return null;
  }
  pckStore.reportState(sn, {
    content_id: state.content_id,
    product_model: state.product_model,
    launcher_version_code: launcherVersionCode,
    active_content_version: state.active_content_version,
    active_sha256: state.active_sha256,
    pending_content_version: state.pending_content_version,
    activation_state: state.activation_state,
  });
  const dev = pckStore.getDevice(sn);
  const decide = (reason: string, offer: PckRelease | null): ContentUpdate | null => {
    pckStore.recordDecision(sn, reason, offer ? offer.id : null);
    if (offer) {
      pckStore.logServer(sn, state.content_id, 'offered', 'offer', `release#${offer.id}`, offer.content_version);
      console.log(`[pck] offer sn=…${sn.slice(-4)} ${state.active_content_version ?? '-'} -> ${offer.content_version} (release#${offer.id})`);
      return toContentUpdate(offer);
    }
    return null;
  };
  if (dev?.frozen) return decide('frozen', null);
  const candidates = pckStore.publishedCandidates(state.content_id);
  if (candidates.length === 0) return decide('no_release', null);
  let firstReason = '';
  for (const r of candidates) {
    const reason = eligibilityReason(r, sn, launcherVersionCode, state);
    if (!reason) return decide('offer', r);
    if (!firstReason) firstReason = reason;
  }
  return decide(firstReason, null);
}

/** 合同 §5.2 八条（1 Bearer=SN 与 8 冻结在外层）；返回空串=合格。 */
export function eligibilityReason(r: PckRelease & { rollout: { policy: string; sns: string } }, sn: string, launcherVersionCode: number, state: ContentState): string {
  if (r.rollout.policy === 'sns' && !parseSns(r.rollout.sns).includes(sn)) return 'sn_not_in_rollout';
  if (r.rollout.policy === 'none') return 'no_rollout';
  const models = jsonArr(r.product_models);
  if (!state.product_model || !models.includes(state.product_model)) return 'model_mismatch';
  if (launcherVersionCode < r.min_launcher_version_code) return 'launcher_too_old';
  if (state.active_content_version === r.content_version) return 'same_version';
  if (state.pending_content_version === r.content_version) return 'pending_same';
  try {
    // 目标文件/长度与发布记录一致（SHA 在 publish 时已重算；offer 时只做 stat，不每次 hash 20MB）
    const st = statSyncSafe(r.file_path);
    if (!st || st !== r.length) return 'file_missing';
  } catch {
    return 'file_missing';
  }
  return '';
}

function statSyncSafe(p: string): number | null {
  try { return statSync(p).size; } catch { return null; }
}

// ───────────────────────── 设备文件接口 ─────────────────────────

export const pckDeviceRoute = new Hono();

const FILE_RE = /^([0-9a-f]{64})\.pck$/;

pckDeviceRoute.on(['GET', 'HEAD'], '/files/:name', async (c) => {
  const conf = cfg();
  const m = FILE_RE.exec(c.req.param('name'));
  if (!m) return c.json({ ok: false, error: 'not_found' }, 404);
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!snAllowed(cred.sn, conf.allow)) return c.json({ ok: false, error: 'forbidden' }, 403);
  const sha = m[1];
  const rels = pckStore.listBySha(sha);
  if (rels.length === 0) return c.json({ ok: false, error: 'not_found' }, 404);
  const readable = rels.some((r) => r.status === 'published' || r.status === 'paused');
  if (!readable) {
    if (rels.every((r) => r.status === 'revoked')) return c.json({ ok: false, error: 'revoked' }, 410);
    return c.json({ ok: false, error: 'not_found' }, 404); // 只有草稿：设备不可见
  }
  const rel = rels.find((r) => r.status === 'published') ?? rels[0];
  const size = statSyncSafe(rel.file_path);
  if (size === null || size !== rel.length) {
    console.error(`[pck] file inconsistent sha=${sha.slice(0, 8)} release#${rel.id} size=${size} expect=${rel.length}`);
    return c.json({ ok: false, error: 'file_inconsistent' }, 500);
  }
  const range = c.req.header('range') || '';
  console.log(`[pck] file sn=…${cred.sn.slice(-4)} sha=${sha.slice(0, 8)} ${c.req.method}${range ? ' ' + range : ''} mode=${conf.serveMode}`);

  if (conf.serveMode === 'xaccel') {
    // nginx internal location 出流：Range/206/HEAD/限速全由 nginx 处理；本响应体为空
    return new Response(null, {
      status: 200,
      headers: {
        'X-Accel-Redirect': `${conf.xaccelPrefix}${sha}.pck`,
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, max-age=0',
      },
    });
  }

  // direct：Node 自己流式（含 Range）。单段 bytes=a-b / bytes=a- / bytes=-n
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=0',
    ETag: `"${sha}"`,
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    const rm = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!rm || (rm[1] === '' && rm[2] === '')) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    if (rm[1] === '') {
      const n = Number(rm[2]);
      start = Math.max(0, size - n);
    } else {
      start = Number(rm[1]);
      if (rm[2] !== '') end = Math.min(size - 1, Number(rm[2]));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  if (c.req.method === 'HEAD') return new Response(null, { status, headers });
  const stream = Readable.toWeb(createReadStream(rel.file_path, { start, end })) as unknown as ReadableStream;
  return new Response(stream, { status, headers });
});

// ───────────────────────── admin ─────────────────────────

export const pckAdminRoute = new Hono();

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MODEL_RE = /^[A-Za-z0-9_.-]{2,64}$/;

function parseModels(raw: string | undefined, fallback: string[]): string[] | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const arr = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (arr.length === 0 || arr.some((m) => !MODEL_RE.test(m))) return null;
  return [...new Set(arr)];
}

pckAdminRoute.put('/upload', async (c) => {
  const conf = cfg();
  const filename = (c.req.query('filename') || 'upload.pck').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!filename.endsWith('.pck')) return c.json({ ok: false, error: 'bad_filename', message: '仅接受 .pck' }, 400);
  const contentVersion = (c.req.query('content_version') || '').trim();
  if (!VERSION_RE.test(contentVersion)) return c.json({ ok: false, error: 'bad_version', message: 'content_version 须为 2~64 位字母数字 . _ -（如 v214-art-1）' }, 400);
  const models = parseModels(c.req.query('product_models'), ['rk3562_rc160']);
  if (!models) return c.json({ ok: false, error: 'bad_models', message: 'product_models 不合法（逗号分隔机型）' }, 400);
  const minLauncher = Number.parseInt(c.req.query('min_launcher_version_code') || '212', 10);
  if (!Number.isInteger(minLauncher) || minLauncher < 1 || minLauncher > 100000) return c.json({ ok: false, error: 'bad_min_launcher' }, 400);
  const notes = (c.req.query('notes') || '').trim().slice(0, 500);
  const contentId = PCK_CONTENT_ID;
  const body = c.req.raw.body;
  if (!body) return c.json({ ok: false, error: 'empty_body' }, 400);

  await mkdir(conf.pckDir, { recursive: true });
  const tmpPath = join(conf.pckDir, `incoming-${randomUUID()}.pck`);
  const max = pckMaxBytes();
  let received = 0;
  const hash = createHash('sha256');
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > max) controller.error(new Error('too_large'));
      else { hash.update(chunk); controller.enqueue(chunk); }
    },
  });
  try {
    await pipeline(Readable.fromWeb(body.pipeThrough(limiter) as any), createWriteStream(tmpPath));
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const msg = (err as Error).message === 'too_large' ? `PCK 超过硬上限 ${Math.round(max / 1048576)}MiB` : '上传中断';
    return c.json({ ok: false, error: 'upload_failed', message: msg }, 400);
  }
  let facts;
  try {
    facts = await inspectPck(tmpPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const e = err as PckInspectError;
    console.warn(`[pck] upload rejected code=${e.code ?? 'inspect_failed'} ${e.message}`);
    return c.json({ ok: false, error: e.code ?? 'inspect_failed', message: `PCK 解析失败：${e.message.slice(0, 200)}` }, 400);
  }
  if (facts.forbidden.length > 0) {
    await unlink(tmpPath).catch(() => {});
    console.warn(`[pck] upload rejected forbidden=${facts.forbidden.length}`);
    return c.json({ ok: false, error: 'forbidden_content', message: `含代码/原生扩展，首期只允许非执行内容：${facts.forbidden.slice(0, 5).join('、')}${facts.forbidden.length > 5 ? '…' : ''}`, forbidden: facts.forbidden.slice(0, 50) }, 400);
  }
  // 不可变：同 content_id+content_version 已存在 → 同 SHA=重复，不同 SHA=违规，都拒
  const dup = pckStore.getByVersion(contentId, contentVersion);
  if (dup) {
    await unlink(tmpPath).catch(() => {});
    const same = dup.sha256 === facts.sha256;
    console.warn(`[pck] upload rejected ${same ? 'duplicate' : 'immutable_violation'} version=${contentVersion}`);
    return c.json({ ok: false, error: same ? 'duplicate' : 'immutable_violation', message: same ? `${contentVersion} 已存在（同一字节）` : `${contentVersion} 已存在且字节不同：已发布版本不可改写，请换新 content_version` }, 409);
  }
  const finalPath = join(conf.pckDir, `${facts.sha256}.pck`);
  if (statSyncSafe(finalPath) !== null) await unlink(tmpPath).catch(() => {}); // 内容寻址：同字节已在
  else await rename(tmpPath, finalPath);
  const rel = pckStore.insertRelease({
    content_id: contentId,
    content_version: contentVersion,
    product_models: JSON.stringify(models),
    min_launcher_version_code: minLauncher,
    length: facts.size_bytes,
    sha256: facts.sha256,
    file_path: finalPath,
    required_resources: JSON.stringify(facts.required_resources),
    release_notes: JSON.stringify(notes ? [notes] : []),
    force: 0,
    status: 'draft',
    rollback_of: null,
    godot_version: facts.godot_version,
    file_count: facts.file_count,
  });
  console.log(`[pck] uploaded ${contentVersion} sha=${facts.sha256.slice(0, 12)}… ${facts.size_bytes}B files=${facts.file_count} godot=${facts.godot_version} manifest=${facts.manifest_found} required=${facts.required_resources.length}`);
  return c.json({ ok: true, release: view(rel), facts: { ...facts, paths: facts.paths.slice(0, 200) } });
});

function view(r: PckRelease & { rollout?: unknown }) {
  const rollout = (r as { rollout?: unknown }).rollout ?? pckStore.getRollout(r.id);
  return {
    ...r,
    file_path: undefined,
    product_models: jsonArr(r.product_models),
    required_resources: jsonArr(r.required_resources),
    release_notes: jsonArr(r.release_notes),
    asset_name: `${PCK_ASSET_PREFIX}${r.sha256}.pck`,
    rollout,
    devices_active: pckStore.countDevicesOnVersion(r.content_version),
  };
}

pckAdminRoute.get('/releases', (c) => c.json({ ok: true, releases: pckStore.listReleases().map(view) }));

const MetaSchema = z.object({
  product_models: z.array(z.string().regex(MODEL_RE)).min(1).max(20).optional(),
  min_launcher_version_code: z.number().int().min(1).max(100000).optional(),
  required_resources: z.array(z.string().max(512)).max(500).optional(),
  release_notes: z.array(z.string().max(500)).max(20).optional(),
  force: z.boolean().optional(),
});

pckAdminRoute.patch('/releases/:id', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const rel = pckStore.getRelease(id);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  if (rel.status !== 'draft') return c.json({ ok: false, error: 'not_draft', message: '只有草稿可改元数据；已发布版本不可变，请建新 revision' }, 400);
  const parsed = MetaSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', message: parsed.error.issues[0]?.message }, 400);
  const m = parsed.data;
  if (m.required_resources?.some((x) => !x.startsWith('res://'))) return c.json({ ok: false, error: 'bad_required', message: 'required_resources 须以 res:// 开头' }, 400);
  pckStore.updateMeta(id, {
    ...(m.product_models ? { product_models: JSON.stringify([...new Set(m.product_models)]) } : {}),
    ...(m.min_launcher_version_code !== undefined ? { min_launcher_version_code: m.min_launcher_version_code } : {}),
    ...(m.required_resources ? { required_resources: JSON.stringify(m.required_resources) } : {}),
    ...(m.release_notes ? { release_notes: JSON.stringify(m.release_notes) } : {}),
    ...(m.force !== undefined ? { force: m.force ? 1 : 0 } : {}),
  });
  return c.json({ ok: true, release: view(pckStore.getRelease(id)!) });
});

const PublishSchema = z.object({
  rollout: z.enum(['all', 'sns']),
  sns: z.array(z.string().trim().min(1)).optional().default([]),
});

pckAdminRoute.post('/releases/:id/publish', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const rel = pckStore.getRelease(id);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  if (rel.status === 'revoked') return c.json({ ok: false, error: 'revoked', message: '已撤回版本不可再发布；用旧字节建新 rollback revision' }, 400);
  const parsed = PublishSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', message: 'rollout 须为 all 或 sns' }, 400);
  const { rollout, sns } = parsed.data;
  if (rollout === 'sns' && sns.length === 0) return c.json({ ok: false, error: 'empty_sns', message: 'rollout=sns 时名单不可为空' }, 400);
  // 发布前重算：文件、长度、SHA 与记录一致（合同 §5.2.7）
  const size = statSyncSafe(rel.file_path);
  if (size !== rel.length) return c.json({ ok: false, error: 'file_inconsistent', message: `文件长度 ${size} ≠ 记录 ${rel.length}` }, 409);
  const sha = await sha256File(rel.file_path);
  if (sha !== rel.sha256) return c.json({ ok: false, error: 'file_inconsistent', message: '文件 SHA256 与记录不一致（字节被改动）' }, 409);
  pckStore.publish(id, rollout, sns);
  console.log(`[pck] published ${rel.content_version} (release#${id}) rollout=${rollout === 'all' ? 'ALL' : sns.join(',')}`);
  return c.json({ ok: true, release: view(pckStore.getRelease(id)!) });
});

pckAdminRoute.post('/releases/:id/pause', (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const rel = pckStore.getRelease(id);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  if (rel.status !== 'published') return c.json({ ok: false, error: 'not_published' }, 400);
  pckStore.pause(id);
  console.log(`[pck] paused ${rel.content_version} (release#${id})`);
  return c.json({ ok: true, release: view(pckStore.getRelease(id)!) });
});

pckAdminRoute.post('/releases/:id/resume', (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const rel = pckStore.getRelease(id);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  if (rel.status !== 'paused') return c.json({ ok: false, error: 'not_paused' }, 400);
  pckStore.resume(id);
  console.log(`[pck] resumed ${rel.content_version} (release#${id})`);
  return c.json({ ok: true, release: view(pckStore.getRelease(id)!) });
});

pckAdminRoute.post('/releases/:id/revoke', (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const rel = pckStore.getRelease(id);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  if (rel.status === 'revoked') return c.json({ ok: true, release: view(rel) });
  pckStore.revoke(id);
  console.log(`[pck] revoked ${rel.content_version} (release#${id})`);
  return c.json({ ok: true, release: view(pckStore.getRelease(id)!) });
});

const RollbackSchema = z.object({ content_version: z.string().regex(VERSION_RE), notes: z.string().max(500).optional().default('') });

/** 用该版本已验证字节建新 revision（合同 §9.3）：同 SHA、新 content_version、草稿态；发布走常规 publish。 */
pckAdminRoute.post('/releases/:id/rollback', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const src = pckStore.getRelease(id);
  if (!src) return c.json({ ok: false, error: 'not_found' }, 404);
  const parsed = RollbackSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_version', message: 'content_version 不合法' }, 400);
  if (pckStore.getByVersion(src.content_id, parsed.data.content_version)) return c.json({ ok: false, error: 'duplicate', message: '该 content_version 已存在' }, 409);
  const size = statSyncSafe(src.file_path);
  if (size !== src.length) return c.json({ ok: false, error: 'file_inconsistent' }, 409);
  const rel = pckStore.insertRelease({
    content_id: src.content_id,
    content_version: parsed.data.content_version,
    product_models: src.product_models,
    min_launcher_version_code: src.min_launcher_version_code,
    length: src.length,
    sha256: src.sha256,
    file_path: src.file_path,
    required_resources: src.required_resources,
    release_notes: JSON.stringify([parsed.data.notes || `rollback from #${src.id} ${src.content_version}`]),
    force: 0,
    status: 'draft',
    rollback_of: src.id,
    godot_version: src.godot_version,
    file_count: src.file_count,
  });
  console.log(`[pck] rollback revision ${rel.content_version} (release#${rel.id}) from #${src.id} ${src.content_version}`);
  return c.json({ ok: true, release: view(rel) });
});

pckAdminRoute.delete('/releases/:id', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const rel = pckStore.getRelease(id);
  if (!rel) return c.json({ ok: false, error: 'not_found' }, 404);
  if (rel.status !== 'draft' && rel.status !== 'revoked') return c.json({ ok: false, error: 'not_deletable', message: '只能删草稿或已撤回版本；发布中/暂停中先撤回' }, 400);
  if (!pckStore.deleteDraft(id)) return c.json({ ok: false, error: 'delete_failed' }, 500);
  if (pckStore.listBySha(rel.sha256).length === 0) await unlink(rel.file_path).catch(() => {});
  return c.json({ ok: true });
});

pckAdminRoute.get('/devices', (c) => {
  const devices = pckStore.listDevices().map((d) => ({
    ...d,
    last_result: d.last_result_json ? JSON.parse(d.last_result_json) : null,
    last_failure: d.last_failure_json ? JSON.parse(d.last_failure_json) : null,
    last_rollback: d.last_rollback_json ? JSON.parse(d.last_rollback_json) : null,
    last_result_json: undefined, last_failure_json: undefined, last_rollback_json: undefined,
  }));
  return c.json({ ok: true, devices });
});

pckAdminRoute.get('/devices/:sn/log', (c) => {
  const sn = c.req.param('sn').trim();
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') || 50) || 50));
  return c.json({ ok: true, sn, log: pckStore.listLog(sn, limit) });
});

pckAdminRoute.post('/devices/:sn/freeze', async (c) => {
  const sn = c.req.param('sn').trim();
  const body = (await c.req.json().catch(() => ({}))) as { frozen?: unknown };
  const frozen = body.frozen === true;
  pckStore.setFrozen(sn, frozen);
  pckStore.logServer(sn, PCK_CONTENT_ID, 'freeze', frozen ? 'frozen' : 'unfrozen', 'admin');
  console.log(`[pck] ${frozen ? 'froze' : 'unfroze'} sn=…${sn.slice(-4)}`);
  return c.json({ ok: true, sn, frozen });
});

