/**
 * PCK 双 OTA 服务端回归（合同 CODEX_P003_APK_PCK_DUAL_OTA_SERVER_CONTRACT_20260903 §10 J1 离线向量）
 * 跑法：NODE_OPTIONS=--experimental-sqlite npx tsx scripts/ota-pck.test.ts
 *
 * 覆盖：
 *  - 上传实测：合法 PCK 入草稿 + 内嵌 manifest 抽 required_resources / 禁扩展拒 / 坏 magic 拒 / 超 32MiB(测试用 override) 拒
 *  - 不可变：同版本同字节 409 duplicate；同版本不同字节 409 immutable_violation
 *  - check：旧客户端不受影响（update 语义不变、content_update null）；八条 eligibility 逐条 null 原因；命中即完整 content_update
 *  - 回报：append-only 流水 + 双钟；success 不覆盖 failed/rolled_back 证据；未知 stage 归一
 *  - 文件接口：401 / 坏名 404 / 仅草稿 404 / 200 全量(sha 对撞) / HEAD / Range 206 / 越界 416 / 暂停仍可读 / 撤回 410 / xaccel 头
 *  - publish 前重算：字节被改 → 409；rollback 建新 revision 同 SHA；APK 与 PCK 账本分账；草稿删除不误删共享字节
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'pck-test-'));
process.env.OTA_DB_PATH = join(tmp, 'ota.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.OTA_DIR = join(tmp, 'ota-files');
process.env.AUTH_JWT_SECRET = 'test-secret';
process.env.DEVICE_SN_ALLOW = '';
process.env.OTA_URL_BASE = 'https://kidshub-ai.hahaxiong.cc';
process.env.OTA_CHECK_RPM = '1000';
process.env.PCK_MAX_BYTES_OVERRIDE = String(1024 * 1024); // 测试只把硬上限缩到 1MiB，语义同 32MiB
process.env.PCK_SERVE_MODE = 'direct';

const { Hono } = await import('hono');
const { SignJWT } = await import('jose');
const { otaDeviceRoute, otaAdminRoute } = await import('../src/routes/ota.js');
const { pckDeviceRoute, PCK_ASSET_PREFIX } = await import('../src/routes/ota-pck.js');
const { pckStore } = await import('../src/pck-store.js');
const { otaStore } = await import('../src/ota-store.js');
const { buildPck, PCK_FLAG_SPARSE_BUNDLE, PCK_FILE_DELTA } = await import('../src/pck-inspect.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); }
}
function ok(name: string, cond: unknown): void { eq(name, Boolean(cond), true); }

const app = new Hono();
app.route('/v1/device/ota', otaDeviceRoute);
app.route('/v1/device/ota/content', pckDeviceRoute);
app.route('/api/admin/ota', otaAdminRoute);

const SECRET = new TextEncoder().encode('test-secret');
async function cred(sn: string): Promise<string> {
  return new SignJWT({ kind: 'p003-device' }).setSubject(sn).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(SECRET);
}
const SN_A = 'BJP00326060100000701';
const SN_B = 'BJP00326060100000702';
deviceRegistryStore.add(SN_A, 'pck 测试机 A');
deviceRegistryStore.add(SN_B, 'pck 测试机 B');
const CRED_A = await cred(SN_A);
const CRED_B = await cred(SN_B);

const MODEL = 'rk3562_rc160';
const state = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, content_id: 'g1-content', product_model: MODEL, active_content_version: null, pending_content_version: null, activation_state: 'none', active_sha256: null, ...over,
});
async function check(sn: string, token: string | undefined, body: Record<string, unknown>) {
  const res = await app.request('/v1/device/ota/check', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ sn, version_code: 212, version_name: '1.2.2-canary.200', channel: 'stable', ...body }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function upload(bytes: Buffer, q: Record<string, string>) {
  const qs = new URLSearchParams({ filename: 'x.pck', ...q }).toString();
  const res = await app.request(`/api/admin/ota/pck/upload?${qs}`, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function admin(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/admin/ota/pck${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function file(name: string, token?: string, headers: Record<string, string> = {}, method = 'GET') {
  const res = await app.request(`/v1/device/ota/content/files/${name}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const buf = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ── 素材 ──
const manifest = Buffer.from(JSON.stringify({ required_resources: ['res://pck/g1_content_manifest.json', 'res://art/a.png'], note: 'x' }));
const GOOD = buildPck([
  { path: 'res://pck/g1_content_manifest.json', data: manifest },
  { path: 'res://art/a.png', data: Buffer.from('PNGDATA'.repeat(200)) },
  { path: 'res://art/b.json', data: Buffer.from('{"k":1}') },
]);
const GOOD_SHA = sha(GOOD);
const GOOD2 = buildPck([{ path: 'res://art/c.png', data: Buffer.from('OTHER'.repeat(100)) }]);
const BAD_EXT = buildPck([{ path: 'res://art/a.png', data: Buffer.from('x') }, { path: 'res://scripts/hack.gd', data: Buffer.from('print(1)') }]);
const BAD_MAGIC = Buffer.concat([Buffer.from('NOTPCK'), Buffer.alloc(200)]);
const TOO_BIG = buildPck([{ path: 'res://big.bin', data: Buffer.alloc(1024 * 1024 + 1) }]);

// ── 1. 上传实测 ──
{
  const r = await upload(GOOD, { content_version: 'v214-art-1', product_models: MODEL, min_launcher_version_code: '212', notes: '更新 G1 美术' });
  eq('up-1 合法 PCK 入草稿', [r.status, r.json.ok, r.json.release.status], [200, true, 'draft']);
  eq('up-2 sha/length 实测', [r.json.release.sha256, r.json.release.length], [GOOD_SHA, GOOD.length]);
  eq('up-3 内嵌 manifest 抽 required_resources', r.json.release.required_resources, ['res://pck/g1_content_manifest.json', 'res://art/a.png']);
  eq('up-4 asset_name 无前导斜杠', r.json.release.asset_name, `${PCK_ASSET_PREFIX}${GOOD_SHA}.pck`);
  ok('up-5 文件按 sha 落盘', existsSync(join(tmp, 'ota-files', 'pck', `${GOOD_SHA}.pck`)));
  eq('up-6 facts 含 godot 版本/文件数', [r.json.facts.godot_version, r.json.facts.file_count, r.json.facts.manifest_found], ['4.3.0', 3, true]);
}
{
  const r = await upload(BAD_EXT, { content_version: 'v214-bad-1' });
  eq('up-7 禁扩展拒', [r.status, r.json.error], [400, 'forbidden_content']);
  ok('up-8 拒后无文件残留', !existsSync(join(tmp, 'ota-files', 'pck', `${sha(BAD_EXT)}.pck`)));
  const r2 = await upload(BAD_MAGIC, { content_version: 'v214-bad-2' });
  eq('up-9 坏 magic 拒', [r2.status, r2.json.error], [400, 'bad_magic']);
  const r3 = await upload(TOO_BIG, { content_version: 'v214-bad-3' });
  eq('up-10 超硬上限拒', [r3.status, r3.json.error], [400, 'upload_failed']);
  const r4 = await upload(GOOD, { content_version: 'bad version!' });
  eq('up-11 版本名不合法拒', r4.status, 400);
}
// ── 2. 不可变 ──
{
  const r = await upload(GOOD, { content_version: 'v214-art-1' });
  eq('imm-1 同版本同字节 409 duplicate', [r.status, r.json.error], [409, 'duplicate']);
  const r2 = await upload(GOOD2, { content_version: 'v214-art-1' });
  eq('imm-2 同版本不同字节 409 immutable_violation', [r2.status, r2.json.error], [409, 'immutable_violation']);
  eq('imm-3 拒绝后库里仍只 1 条', pckStore.listReleases().length, 1);
}
const REL1 = pckStore.listReleases()[0].id;

// ── 3. check：旧客户端 + 发布前 ──
{
  const r = await check(SN_A, CRED_A, {});
  eq('chk-1 旧客户端：update null + content_update null', [r.status, r.json.update, r.json.content_update], [200, null, null]);
  eq('chk-2 旧客户端投影 legacy', pckStore.getDevice(SN_A)?.last_decision, 'legacy_client');
  const r2 = await check(SN_A, CRED_A, { content_state: state() });
  eq('chk-3 未发布 → null/no_release', [r2.json.content_update, pckStore.getDevice(SN_A)?.last_decision], [null, 'no_release']);
  eq('chk-4 投影记录机型/版本', [pckStore.getDevice(SN_A)?.product_model, pckStore.getDevice(SN_A)?.launcher_version_code], [MODEL, 212]);
}
// ── 4. 发布 + eligibility 八条 ──
{
  const p = await admin('POST', `/releases/${REL1}/publish`, { rollout: 'sns', sns: [SN_A] });
  eq('pub-1 灰度发布', [p.status, p.json.release.status, p.json.release.rollout.policy], [200, 'published', 'sns']);
  const r = await check(SN_A, CRED_A, { content_state: state() });
  const cu = r.json.content_update;
  eq('elig-1 命中：必填字段齐', cu && [cu.schema_version, cu.content_id, cu.content_version, cu.product_models, cu.min_launcher_version_code, cu.length, cu.sha256, cu.activation_policy, cu.force],
    [1, 'g1-content', 'v214-art-1', [MODEL], 212, GOOD.length, GOOD_SHA, 'next_idle_reboot', false]);
  eq('elig-2 asset_name 相对路径', cu?.asset_name, `v1/device/ota/content/files/${GOOD_SHA}.pck`);
  eq('elig-3 required_resources 完整数组', cu?.required_resources, ['res://pck/g1_content_manifest.json', 'res://art/a.png']);
  eq('elig-4 release_notes', cu?.release_notes, ['更新 G1 美术']);
  eq('elig-5 决策/offer 落投影', [pckStore.getDevice(SN_A)?.last_decision, pckStore.getDevice(SN_A)?.last_offer_release_id], ['offer', REL1]);
  const rb = await check(SN_B, CRED_B, { content_state: state() });
  eq('elig-6 不在名单 → null', [rb.json.content_update, pckStore.getDevice(SN_B)?.last_decision], [null, 'sn_not_in_rollout']);
  const rm = await check(SN_A, CRED_A, { content_state: state({ product_model: 'other_model' }) });
  eq('elig-7 机型不符 → null', [rm.json.content_update, pckStore.getDevice(SN_A)?.last_decision], [null, 'model_mismatch']);
  const rl = await check(SN_A, CRED_A, { content_state: state(), version_code: 211 });
  eq('elig-8 Launcher 太旧 → null', [rl.json.content_update, pckStore.getDevice(SN_A)?.last_decision], [null, 'launcher_too_old']);
  const rs = await check(SN_A, CRED_A, { content_state: state({ active_content_version: 'v214-art-1', active_sha256: GOOD_SHA, activation_state: 'confirmed' }) });
  eq('elig-9 已是目标版本 → null', [rs.json.content_update, pckStore.getDevice(SN_A)?.last_decision], [null, 'same_version']);
  const rp = await check(SN_A, CRED_A, { content_state: state({ pending_content_version: 'v214-art-1' }) });
  eq('elig-10 pending 同版本 → null', [rp.json.content_update, pckStore.getDevice(SN_A)?.last_decision], [null, 'pending_same']);
  await admin('POST', `/devices/${SN_A}/freeze`, { frozen: true });
  const rf = await check(SN_A, CRED_A, { content_state: state() });
  eq('elig-11 冻结 → null', [rf.json.content_update, pckStore.getDevice(SN_A)?.last_decision], [null, 'frozen']);
  await admin('POST', `/devices/${SN_A}/freeze`, { frozen: false });
  const rx = await check(SN_A, CRED_A, { content_state: state() });
  eq('elig-12 解冻恢复 offer', rx.json.content_update?.content_version, 'v214-art-1');
  const rc = await check(SN_A, CRED_B, { content_state: state() });
  eq('elig-13 凭据 SN≠body SN 403', rc.status, 403);
}
// ── 5. 回报流水 ──
{
  const n0 = pckStore.listLog(SN_A, 200).length;
  const r1 = await check(SN_A, CRED_A, { content_state: state(), content_last_result: { from_content_version: 'v213', to_content_version: 'v214-art-1', stage: 'failed', status: 'failed', error_code: 'sha_mismatch; rm -rf', result_ts_ms: 1788435720000 } });
  eq('rep-1 失败回报 2xx', r1.status, 200);
  const d1 = pckStore.getDevice(SN_A)!;
  const lf = JSON.parse(d1.last_failure_json);
  eq('rep-2 失败证据落 last_failure + error_code 归一', [lf.stage, lf.error_code, typeof lf.server_received_ms, lf.result_ts_ms], ['failed', 'sha_mismatchrm-rf', 'number', 1788435720000]);
  await check(SN_A, CRED_A, { content_state: state({ active_content_version: 'v214-art-1', active_sha256: GOOD_SHA, activation_state: 'confirmed' }), content_last_result: { from_content_version: 'v213', to_content_version: 'v214-art-1', stage: 'confirmed', status: 'success', error_code: '', result_ts_ms: 1788435800000 } });
  const d2 = pckStore.getDevice(SN_A)!;
  eq('rep-3 success 更新 last_result 但不覆盖失败证据', [JSON.parse(d2.last_result_json).stage, JSON.parse(d2.last_failure_json).stage], ['confirmed', 'failed']);
  await check(SN_A, CRED_A, { content_state: state(), content_last_result: { from_content_version: 'v214-art-1', to_content_version: 'v213', stage: 'rolled_back', status: 'success' } });
  eq('rep-4 回滚证据单独保留', JSON.parse(pckStore.getDevice(SN_A)!.last_rollback_json).stage, 'rolled_back');
  await check(SN_A, CRED_A, { content_state: state(), content_last_result: { stage: 'teleported', status: 'weird' } });
  const log = pckStore.listLog(SN_A, 200).filter((x) => x.source === 'device');
  eq('rep-5 流水 append-only 4 条设备事件', log.length, 4);
  eq('rep-6 未知 stage 归一 unknown', log[0].stage, 'unknown');
  ok('rep-7 server 决策也进流水', pckStore.listLog(SN_A, 200).some((x) => x.source === 'server' && x.stage === 'offered'));
  ok('rep-8 流水只增', pckStore.listLog(SN_A, 200).length > n0);
}
// ── 6. 文件接口（direct）──
{
  const name = `${GOOD_SHA}.pck`;
  eq('file-1 无凭据 401', (await file(name)).status, 401);
  eq('file-2 坏文件名 404', (await file('../etc/passwd', CRED_A)).status, 404);
  eq('file-3 未知 sha 404', (await file(`${'0'.repeat(64)}.pck`, CRED_A)).status, 404);
  const full = await file(name, CRED_A);
  eq('file-4 200 全量 + 长度 + sha 对撞', [full.status, full.headers.get('content-length'), full.headers.get('accept-ranges'), sha(full.buf)], [200, String(GOOD.length), 'bytes', GOOD_SHA]);
  const head = await file(name, CRED_A, {}, 'HEAD');
  eq('file-5 HEAD 只有头', [head.status, head.headers.get('content-length'), head.buf.length], [200, String(GOOD.length), 0]);
  const part = await file(name, CRED_A, { range: 'bytes=10-19' });
  eq('file-6 Range 206', [part.status, part.headers.get('content-range'), part.headers.get('content-length'), part.buf.equals(GOOD.subarray(10, 20))], [206, `bytes 10-19/${GOOD.length}`, '10', true]);
  const tail = await file(name, CRED_A, { range: `bytes=${GOOD.length - 5}-` });
  eq('file-7 尾段续传', [tail.status, tail.buf.equals(GOOD.subarray(GOOD.length - 5))], [206, true]);
  const suffix = await file(name, CRED_A, { range: 'bytes=-7' });
  eq('file-8 后缀 Range', [suffix.status, suffix.buf.length], [206, 7]);
  const beyond = await file(name, CRED_A, { range: `bytes=${GOOD.length + 100}-` });
  eq('file-9 越界 416 + Content-Range */len', [beyond.status, beyond.headers.get('content-range')], [416, `bytes */${GOOD.length}`]);
  // 仅草稿的 sha：设备不可见
  const d = await upload(GOOD2, { content_version: 'v215-draft-1' });
  eq('file-10 仅草稿 404', (await file(`${d.json.release.sha256}.pck`, CRED_A)).status, 404);
  // 暂停仍可读；撤回 410
  await admin('POST', `/releases/${REL1}/pause`);
  eq('file-11 暂停仍可读（防半包风暴）', (await file(name, CRED_A)).status, 200);
  const rpaused = await check(SN_A, CRED_A, { content_state: state() });
  eq('file-12 暂停后 check 不再 offer', [rpaused.json.content_update, pckStore.getDevice(SN_A)?.last_decision], [null, 'no_release']);
  await admin('POST', `/releases/${REL1}/resume`);
  eq('file-13 恢复后再 offer', (await check(SN_A, CRED_A, { content_state: state() })).json.content_update?.content_version, 'v214-art-1');
  // xaccel 模式
  process.env.PCK_SERVE_MODE = 'xaccel';
  const xa = await file(name, CRED_A, { range: 'bytes=0-9' });
  eq('file-14 xaccel：X-Accel-Redirect + 空体', [xa.status, xa.headers.get('x-accel-redirect'), xa.buf.length], [200, `/_pck_internal/${GOOD_SHA}.pck`, 0]);
  process.env.PCK_SERVE_MODE = 'direct';
}
// ── 7. publish 前重算 + rollback + 分账 + 删除 ──
{
  const d = pckStore.listReleases().find((r) => r.content_version === 'v215-draft-1')!;
  const p = d.file_path;
  const orig = readFileSync(p);
  writeFileSync(p, Buffer.concat([orig.subarray(0, orig.length - 1), Buffer.from([orig[orig.length - 1] ^ 0xff])]));
  const pub = await admin('POST', `/releases/${d.id}/publish`, { rollout: 'all' });
  eq('pub-2 字节被改 → 409 file_inconsistent', [pub.status, pub.json.error], [409, 'file_inconsistent']);
  writeFileSync(p, orig);
  const pub2 = await admin('POST', `/releases/${d.id}/publish`, { rollout: 'all' });
  eq('pub-3 复原后可发布(全量)', [pub2.status, pub2.json.release.rollout.policy], [200, 'all']);
  const rb = await check(SN_B, CRED_B, { content_state: state() });
  eq('pub-4 最新发布优先：SN_B 拿到 v215', rb.json.content_update?.content_version, 'v215-draft-1');
  // 元数据只在草稿可改
  const meta = await admin('PATCH', `/releases/${d.id}`, { force: true });
  eq('meta-1 已发布不可改', meta.status, 400);
  // rollback：用 REL1 字节建新 revision
  const rk = await admin('POST', `/releases/${REL1}/rollback`, { content_version: 'v216-rollback-v214-1' });
  eq('rb-1 回滚版=草稿+同 SHA+rollback_of', [rk.status, rk.json.release.status, rk.json.release.sha256, rk.json.release.rollback_of], [200, 'draft', GOOD_SHA, REL1]);
  const m2 = await admin('PATCH', `/releases/${rk.json.release.id}`, { release_notes: ['回滚到 v214 字节'], min_launcher_version_code: 212 });
  eq('meta-2 草稿可改', [m2.status, m2.json.release.release_notes], [200, ['回滚到 v214 字节']]);
  await admin('POST', `/releases/${rk.json.release.id}/publish`, { rollout: 'sns', sns: [SN_B] });
  const rb2 = await check(SN_B, CRED_B, { content_state: state({ active_content_version: 'v215-draft-1' }) });
  eq('rb-2 设备拿到回滚版', rb2.json.content_update?.content_version, 'v216-rollback-v214-1');
  // 撤回 → 文件 410（该 sha 的所有 release 都撤回时）
  await admin('POST', `/releases/${d.id}/revoke`);
  eq('rv-1 撤回后 410', (await file(`${d.sha256}.pck`, CRED_A)).status, 410);
  eq('rv-2 撤回不可再发布', (await admin('POST', `/releases/${d.id}/publish`, { rollout: 'all' })).status, 400);
  // APK 与 PCK 分账
  const pckLogN = pckStore.listLog(SN_A, 500).length;
  await check(SN_A, CRED_A, { last_result: { from_version_code: 211, to_version_code: 212, status: 'success' } });
  eq('sep-1 APK last_result 不进 PCK 流水', pckStore.listLog(SN_A, 500).length, pckLogN);
  const apkBefore = otaStore.listDeviceStatus().find((x) => x.sn === SN_A)!.last_result_json;
  await check(SN_A, CRED_A, { content_state: state(), content_last_result: { stage: 'staged', status: 'success', to_content_version: 'v214-art-1' } });
  eq('sep-2 PCK 回报不动 APK 台账', otaStore.listDeviceStatus().find((x) => x.sn === SN_A)!.last_result_json, apkBefore);
  eq('sep-3 APK 台账仍是 APK 语义', JSON.parse(apkBefore).to_version_code, 212);
  // 草稿删除：共享 sha 的字节不删
  const dr = await upload(GOOD, { content_version: 'v217-draft-shared' });
  eq('del-1 同字节新版本入草稿', dr.status, 200);
  const del = await admin('DELETE', `/releases/${dr.json.release.id}`);
  eq('del-2 删草稿成功', del.status, 200);
  ok('del-3 共享字节文件仍在', existsSync(join(tmp, 'ota-files', 'pck', `${GOOD_SHA}.pck`)));
  eq('del-4 已发布不可删', (await admin('DELETE', `/releases/${REL1}`)).status, 400);
  const revoked = pckStore.listReleases().find((r) => r.status === 'revoked')!;
  eq('del-5 已撤回可删（记录清理，流水保留）', (await admin('DELETE', `/releases/${revoked.id}`)).status, 200);
  ok('del-6 撤回版删除后流水仍在', pckStore.listLog(SN_B, 500).some((x) => x.to_version === 'v215-draft-1'));
  // devices 视图
  const dv = await admin('GET', '/devices');
  ok('dev-1 devices 视图含两台', dv.json.devices.length >= 2);
  const lg = await admin('GET', `/devices/${SN_A}/log?limit=5`);
  eq('dev-2 日志接口', [lg.status, lg.json.log.length], [200, 5]);
}

// ── 8. Godot 4.5 pack format 3（2026-09-04 codex 交接真包实证：V3 头带 dir_offset，目录不再紧随头部）──
{
  const GOOD_V3 = buildPck([
    { path: 'res://pck/g1_content_manifest.json', data: manifest },
    { path: 'res://art/v3.png', data: Buffer.from('V3DATA'.repeat(300)) },
  ], { version: 3 });
  const r = await upload(GOOD_V3, { content_version: 'v3-format-1', product_models: MODEL, min_launcher_version_code: '217' });
  eq('v3-1 V3 包入草稿', [r.status, r.json.ok, r.json.release.status], [200, true, 'draft']);
  eq('v3-2 facts pack_version/godot/文件数/manifest', [r.json.facts.pack_version, r.json.facts.godot_version, r.json.facts.file_count, r.json.facts.manifest_found], [3, '4.5.0', 2, true]);
  eq('v3-3 sha/length 实测', [r.json.release.sha256, r.json.release.length], [sha(GOOD_V3), GOOD_V3.length]);
  eq('v3-4 V3 内嵌 manifest 抽 required_resources', r.json.release.required_resources, ['res://pck/g1_content_manifest.json', 'res://art/a.png']);
  const sparse = buildPck([{ path: 'res://art/s.png', data: Buffer.from('x'.repeat(50)) }], { version: 3, packFlags: PCK_FLAG_SPARSE_BUNDLE });
  const rs = await upload(sparse, { content_version: 'v3-sparse-1' });
  eq('v3-5 稀疏包（文件在 pck 外）拒', [rs.status, rs.json.error], [400, 'sparse_bundle_unsupported']);
  const badDir = buildPck([{ path: 'res://art/d.png', data: Buffer.from('x'.repeat(50)) }], { version: 3, dirOffsetOverride: 10_000_000 });
  const rd = await upload(badDir, { content_version: 'v3-baddir-1' });
  eq('v3-6 目录偏移越界拒', [rd.status, rd.json.error], [400, 'bad_offset']);
  const v4 = Buffer.from(GOOD_V3);
  v4.writeUInt32LE(4, 4);
  const r4 = await upload(v4, { content_version: 'v4-format-1' });
  eq('v3-7 未知格式 4 拒', [r4.status, r4.json.error], [400, 'pack_version_unsupported']);
  const v3ext = buildPck([{ path: 'res://art/a.png', data: Buffer.from('x') }, { path: 'res://scripts/hack.gdc', data: Buffer.from('bin') }], { version: 3 });
  const re = await upload(v3ext, { content_version: 'v3-badext-1' });
  eq('v3-8 V3 禁扩展门照常', [re.status, re.json.error], [400, 'forbidden_content']);
  // Godot 4.6.1 真包形态：目录路径不带 res:// 前缀，manifest 正文却写 res://（2026-09-04 实证 required_resources 抽空）
  const V3_NOPREFIX = buildPck([
    { path: 'pck/g1_content_manifest.json', data: manifest },
    { path: 'pck/g1_art_inventory.json', data: Buffer.from('{"files":[]}') },
    { path: '.godot/imported/x.ctex', data: Buffer.from('CTEX'.repeat(50)) },
  ], { version: 3, godot: [4, 6, 1] });
  const rn = await upload(V3_NOPREFIX, { content_version: 'v3-noprefix-1', product_models: MODEL, min_launcher_version_code: '217' });
  eq('v3-11 目录无 res:// 前缀仍抽到 manifest', [rn.status, rn.json.facts.manifest_found, rn.json.release.required_resources], [200, true, ['res://pck/g1_content_manifest.json', 'res://art/a.png']]);
  eq('v3-12 无前缀路径的禁扩展照拒', (await upload(buildPck([{ path: 'scripts/hack.gd', data: Buffer.from('x') }], { version: 3 }), { content_version: 'v3-noprefix-bad' })).json.error, 'forbidden_content');
  const delta = buildPck([{ path: 'pck/a.png', data: Buffer.from('x'.repeat(30)) }], { version: 3, fileFlags: PCK_FILE_DELTA });
  const rdl = await upload(delta, { content_version: 'v3-delta-1' });
  eq('v3-13 增量补丁条目拒', [rdl.status, rdl.json.error], [400, 'file_delta_unsupported']);
  eq('v3-14 清理无前缀草稿', (await admin('DELETE', `/releases/${rn.json.release.id}`)).status, 200);
  const v2again = await upload(GOOD, { content_version: 'v2-still-ok-1' });
  eq('v3-9 V2 仍可上传（回归锚）', [v2again.status, v2again.json.facts.pack_version], [200, 2]);
  eq('v3-10 清理 V3/V2 草稿', [(await admin('DELETE', `/releases/${r.json.release.id}`)).status, (await admin('DELETE', `/releases/${v2again.json.release.id}`)).status], [200, 200]);
}

console.log(`\nota-pck tests: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
