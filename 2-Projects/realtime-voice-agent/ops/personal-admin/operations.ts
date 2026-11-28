import {open} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {getNightDevices, NightBridgeError, parseDeviceId, NIGHT_BRIDGE_SOCKET} from './night-devices.ts';

const PUBLIC_SITE = 'https://pa.hahaxiong.cc:8666';
const MANIFEST_PATH = '/mobile/night/latest.json';
const MAX_JSON = 16 * 1024;
const unavailable = {state: 'unavailable'} as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function label(value: unknown, limit = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim();
}

function time(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function otaResult(input: Record<string, unknown>) {
  if (input.schema !== 1 || input.channel !== 'night' || input.packageName !== 'cc.hahaxiong.xiaoke.night'
      || !positive(input.versionCode) || !positive(input.size) || !label(input.versionName, 32)
      || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)
      || !time(input.publishedAt)) return unavailable;
  const path = '/mobile/night/xiaoke-night-' + input.versionCode + '.apk';
  if (input.url !== PUBLIC_SITE + path || input.apkUrl !== path) return unavailable;
  return {
    state: 'ready' as const, versionName: input.versionName, versionCode: input.versionCode, publishedAt: time(input.publishedAt),
    size: input.size, sha256: input.sha256, url: PUBLIC_SITE + path, notes: label(input.notes, 1024),
  };
}

function speechResult(input: Record<string, unknown>) {
  if (input.ok !== true || input.provider !== 'personal-local-pilot' || !label(input.asr_model)
      || !label(input.voice) || !label(input.tts_model) || !positive(input.output_rate) || !positive(input.tts_native_rate)) return unavailable;
  return {
    state: 'ready' as const, asrModel: input.asr_model, ttsModel: input.tts_model, voice: input.voice,
    nativeRate: input.tts_native_rate, outputRate: input.output_rate,
  };
}

function brainResult(input: Record<string, unknown>) {
  if (input.ok !== true || input.service !== 'personal-brain') return unavailable;
  const providers = record(input.providers);
  const llm = record(providers.llm), asr = record(providers.asr), tts = record(providers.tts);
  return {
    state: 'ready' as const, build: label(input.build), providerState: label(providers.state),
    revision: providers.revision === 0 || positive(providers.revision) ? providers.revision : null,
    activeLlm: label(llm.provider), llmProfile: label(llm.profile), llmModel: label(llm.model),
    activeAsr: label(asr.provider), asrProfile: label(asr.profile),
    activeTts: label(tts.provider), ttsProfile: label(tts.profile),
  };
}

async function probe<T>(origin: string | undefined, path: string, select: (value: Record<string, unknown>) => T) {
  if (!origin) return unavailable;
  try {
    const response = await fetch(new URL(path || origin, origin), {redirect: 'error', signal: AbortSignal.timeout(2500)});
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_JSON) {
      await response.body?.cancel();
      return unavailable;
    }
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let length = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_JSON) { await reader.cancel(); return unavailable; }
      chunks.push(value);
    }
    return select(record(JSON.parse(Buffer.concat(chunks, length).toString('utf8'))));
  } catch { return unavailable; }
}

async function backupReceipt(file: string) {
  try {
    const stream = await open(file, 'r');
    try {
      const stat = await stream.stat();
      if (!stat.isFile() || stat.size > MAX_JSON) return unavailable;
      const receipt = record(JSON.parse(await stream.readFile('utf8')));
      const verifiedAt = time(receipt.verifiedAt), capturedAt = time(receipt.capturedAt);
      if (receipt.schema !== 1 || receipt.scope !== 'personal-voice' || receipt.databaseCount !== 6
          || !positive(receipt.archiveBytes) || !verifiedAt || !capturedAt || verifiedAt < capturedAt) return unavailable;
      return {state: 'verified' as const, capturedAt, verifiedAt, databaseCount: receipt.databaseCount, archiveBytes: receipt.archiveBytes};
    } finally { await stream.close(); }
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {state: 'unreported' as const} : unavailable; }
}

// All destinations come from deployment configuration. The management request supplies no URLs or paths.
export async function getOperations(env: NodeJS.ProcessEnv = process.env) {
  const [ota, speech, brain, backup] = await Promise.all([
    probe(env.TALK_SITE_ORIGIN, MANIFEST_PATH, otaResult),
    probe(env.SPEECH_ORIGIN, '/health', speechResult),
    probe(env.BRAIN_HEALTH_URL, '', brainResult),
    backupReceipt(env.PERSONAL_BACKUP_RECEIPT || '/app/data/backup-receipt.json'),
  ]);
  return {sampledAt: new Date().toISOString(), ota, speech, brain, backup};
}

const technicalEvents = ['call_start', 'connected', 'mic_on', 'mic_off', 'rx_audio', 'rx_caption', 'tx_caption',
  'spoken_interrupt', 'cancel_ack', 'transport_error', 'call_end', 'paired', 'ota_check'];
const eventFilter = 'device=? AND received_at BETWEEN ? AND ? AND kind IN (' + technicalEvents.map(() => '?').join(',') + ')';

export async function getDeviceDiagnostics(device: string, windowDays?: string,
    file = '/run/night-diagnostics/diagnostics.sqlite3', socket = NIGHT_BRIDGE_SOCKET) {
  const name = parseDeviceId(device);
  if (windowDays !== undefined && !['1', '7', '30'].includes(windowDays)) throw new NightBridgeError('请选择 1、7 或 30 天', 400);
  const days = Number(windowDays ?? '7');
  const {devices} = await getNightDevices(socket);
  if (!devices.some(entry => entry.device === name)) throw new NightBridgeError('当前设备列表中没有该设备', 404);
  const end = Math.floor(Date.now()/1000), start = end - days * 86400;
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const args = [name, start, end, ...technicalEvents];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, {readOnly: true, allowExtension: false});
    db.exec('PRAGMA query_only=ON; BEGIN');
    const counts = db.prepare('SELECT kind, COUNT(*) AS count FROM events WHERE ' + eventFilter
      + ' GROUP BY kind ORDER BY count DESC,kind').all(...args);
    const recent = db.prepare('SELECT kind,ts,received_at,version_code FROM events WHERE ' + eventFilter
      + ' ORDER BY received_at DESC,ts DESC,id DESC LIMIT 60').all(...args)
      .map(row => ({kind: row.kind, at: iso(Number(row.ts)), receivedAt: iso(Number(row.received_at)), versionCode: row.version_code}));
    // A retried batch increments repeats but keeps its original received_at and inserted count.
    const uploads = db.prepare(`SELECT coalesce(sum(repeats),0) AS batches, coalesce(sum(events*repeats),0) AS submitted,
      coalesce(sum(inserted),0) AS inserted, max(received_at) AS lastAt FROM ingest
      WHERE device=? AND received_at BETWEEN ? AND ?`).get(name, start, end)!;
    const submitted = Number(uploads.submitted), inserted = Number(uploads.inserted);
    db.exec('COMMIT');
    return {state: 'ready', days, from: iso(start), through: iso(end), counts, recent,
      uploads: {batches: Number(uploads.batches), submitted, inserted, repeats: submitted - inserted,
        lastAt: uploads.lastAt === null ? null : iso(Number(uploads.lastAt))},
      total: counts.reduce((sum, row) => sum + Number(row.count), 0)};
  } catch { throw new NightBridgeError('技术事件库暂时不可读', 503); }
  finally { db?.close(); }
}
