import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Official DeepSeek chat origin. Profile keys never leave this host. */
export const DEEPSEEK_CHAT_BASE = 'https://api.deepseek.com/v1';
export const DEEPSEEK_CHAT_URL = `${DEEPSEEK_CHAT_BASE}/chat/completions`;

const MAX_BYTES = 262_144;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SPEED_RE = /^(?:0\.[5-9]\d?|1(?:\.\d{1,2})?|2(?:\.0{1,2})?)$/;
const ASR_URLS = new Set([
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
]);

type Kind = 'llm' | 'asr' | 'tts';
type Mount = 'unset' | 'ready' | 'missing' | 'unreadable';
type Reason = 'json' | 'schema' | 'size' | 'io';

export type ResolvedLlm =
  | { provider: 'cpa' }
  | { provider: 'deepseek'; profile: string; model: string; apiKey: string };

export type ProviderHealth = {
  state: 'absent' | 'ready' | 'invalid';
  mount: Mount;
  reason?: Reason;
  revision: number | null;
  active: { llm: string | null; asr: string | null; tts: string | null };
  llm: { provider: 'cpa' | 'deepseek'; profile: string | null; model: string | null };
  asr: { provider: 'feiniu-zh' | 'doubao_asr'; profile: string | null };
  tts: { provider: 'feiniu-voices' | 'doubao_tts' | 'xfyun_tts'; profile: string | null };
};

type Profile = {
  id: string;
  kind: Kind;
  driver: 'deepseek' | 'doubao_asr' | 'doubao_tts' | 'xfyun_tts';
  name: string;
  model: string | null;
  apiKey?: string;
};

type Snap = ProviderHealth & { profiles: Profile[] };

const emptyActive = { llm: null, asr: null, tts: null };

let cache: { path: string; hash: string; snap: Snap } | undefined;

export function resetProviderCache() {
  cache = undefined;
}

function cpaModel() {
  const model = process.env.BRAIN_UPSTREAM_MODEL;
  return model && model.length <= 80 ? model : null;
}

function fallback(state: Snap['state'], mount: Mount, reason?: Reason): Snap {
  return {
    state, mount, ...(reason ? { reason } : {}), revision: null, active: { ...emptyActive }, profiles: [],
    llm: { provider: 'cpa', profile: null, model: cpaModel() },
    asr: { provider: 'feiniu-zh', profile: null },
    tts: { provider: 'feiniu-voices', profile: null },
  };
}

function mountOf(file: string): Mount {
  try {
    return statSync(dirname(file)).isDirectory() ? 'ready' : 'missing';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

function plain(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  return value as Record<string, unknown>;
}

function fields(value: unknown, allowed: readonly string[]): Record<string, string> | undefined {
  const record = plain(value);
  if (!record) return;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!allowed.includes(key) || typeof item !== 'string' || !item.trim() || item.length > 4096 || /[\u0000-\u001f\u007f]/.test(item)) return;
    if (key !== 'VOLC_ASR_URL' && /:\/\//.test(item)) return;
    out[key] = item.trim();
  }
  return out;
}

function modelId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function profileId(value: unknown): value is string {
  return typeof value === 'string' && value !== 'active' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value);
}

function secretValue(value: string | undefined) {
  return typeof value === 'string' && /^[\x21-\x7e]{8,512}$/.test(value) && !value.includes('://');
}

function optional(config: Record<string, string>, key: string, pattern: RegExp) {
  return config[key] === undefined || pattern.test(config[key]);
}

function profile(value: unknown): Profile | undefined {
  const record = plain(value);
  if (!record || Object.keys(record).some((key) => !['id', 'kind', 'driver', 'name', 'config', 'secrets'].includes(key))) return;
  if (!profileId(record.id) || typeof record.name !== 'string') return;
  const name = record.name.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return;
  const kind = record.kind;
  const driver = record.driver;
  if (kind === 'llm' && driver === 'deepseek') {
    const config = fields(record.config, ['DEEPSEEK_MODEL']);
    const secrets = fields(record.secrets, ['DEEPSEEK_API_KEY']);
    if (!config || !secrets || !modelId(config.DEEPSEEK_MODEL) || !secretValue(secrets.DEEPSEEK_API_KEY)) return;
    return { id: record.id, kind, driver, name, model: config.DEEPSEEK_MODEL, apiKey: secrets.DEEPSEEK_API_KEY };
  }
  if (kind === 'asr' && driver === 'doubao_asr') {
    const config = fields(record.config, ['VOLC_ASR_RESOURCE_ID', 'VOLC_ASR_URL', 'VOLC_ASR_END_WINDOW_MS', 'VOLC_ASR_ENABLE_DDC']);
    const secrets = fields(record.secrets, ['VOLC_APP_ID', 'VOLC_ACCESS_TOKEN', 'VOLC_ASR_API_KEY']);
    const pair = Boolean(secretValue(secrets?.VOLC_APP_ID) && secretValue(secrets?.VOLC_ACCESS_TOKEN));
    const apiKey = secretValue(secrets?.VOLC_ASR_API_KEY);
    if (!config || !secrets || !TOKEN_RE.test(config.VOLC_ASR_RESOURCE_ID ?? '')) return;
    if (config.VOLC_ASR_URL !== undefined && !ASR_URLS.has(config.VOLC_ASR_URL)) return;
    if (!optional(config, 'VOLC_ASR_END_WINDOW_MS', /^(?:[1-9]\d{0,4})$/) || !optional(config, 'VOLC_ASR_ENABLE_DDC', /^(?:0|1)$/)) return;
    if (!pair && !apiKey) return;
    if ((secrets.VOLC_APP_ID !== undefined && !secretValue(secrets.VOLC_APP_ID)) || (secrets.VOLC_ACCESS_TOKEN !== undefined && !secretValue(secrets.VOLC_ACCESS_TOKEN))) return;
    return { id: record.id, kind, driver, name, model: null };
  }
  if (kind === 'tts' && driver === 'doubao_tts') {
    const config = fields(record.config, ['VOLC_TTS_RESOURCE_ID', 'VOLC_TTS_SPEAKER', 'VOLC_TTS_SPEED']);
    const secrets = fields(record.secrets, ['VOLC_APP_ID', 'VOLC_ACCESS_TOKEN']);
    if (!config || !secrets || !secretValue(secrets.VOLC_APP_ID) || !secretValue(secrets.VOLC_ACCESS_TOKEN)) return;
    if (!TOKEN_RE.test(config.VOLC_TTS_RESOURCE_ID ?? '') || !TOKEN_RE.test(config.VOLC_TTS_SPEAKER ?? '')) return;
    if (!optional(config, 'VOLC_TTS_SPEED', SPEED_RE)) return;
    return { id: record.id, kind, driver, name, model: null };
  }
  if (kind === 'tts' && driver === 'xfyun_tts') {
    const config = fields(record.config, ['XFYUN_TTS_VCN', 'XFYUN_TTS_SPEED', 'XFYUN_TTS_ORAL_LEVEL', 'XFYUN_TTS_PRECONNECT']);
    const secrets = fields(record.secrets, ['XFYUN_TTS_APP_ID', 'XFYUN_TTS_API_KEY', 'XFYUN_TTS_API_SECRET']);
    if (!config || !secrets || !secretValue(secrets.XFYUN_TTS_APP_ID) || !secretValue(secrets.XFYUN_TTS_API_KEY) || !secretValue(secrets.XFYUN_TTS_API_SECRET)) return;
    if (!TOKEN_RE.test(config.XFYUN_TTS_VCN ?? '')) return;
    if (!optional(config, 'XFYUN_TTS_PRECONNECT', /^(?:0|1)$/)) return;
    if (!optional(config, 'XFYUN_TTS_SPEED', /^(?:100|[1-9]?\d)$/) || !optional(config, 'XFYUN_TTS_ORAL_LEVEL', /^(?:low|mid|high)$/)) return;
    return { id: record.id, kind, driver, name, model: null };
  }
  return;
}

export function interpretProviders(raw: unknown): Snap | undefined {
  const root = plain(raw);
  const active = root ? plain(root.active) : undefined;
  if (!root || root.version !== 1 || typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 0) return;
  if (!Array.isArray(root.profiles) || root.profiles.length > 32 || !active) return;
  if (Object.keys(root).some((key) => !['version', 'revision', 'profiles', 'active'].includes(key))) return;
  if (Object.keys(active).some((key) => !['llm', 'asr', 'tts'].includes(key))) return;
  const profiles: Profile[] = [];
  for (const item of root.profiles) {
    const parsed = profile(item);
    if (!parsed || profiles.some((known) => known.id === parsed.id)) return;
    profiles.push(parsed);
  }
  const selected = {} as Snap['active'];
  for (const kind of ['llm', 'asr', 'tts'] as const) {
    const id = active[kind];
    if (id === null) { selected[kind] = null; continue; }
    if (typeof id !== 'string' || !profiles.some((item) => item.id === id && item.kind === kind)) return;
    selected[kind] = id;
  }
  const llm = profiles.find((item) => item.id === selected.llm);
  const asr = profiles.find((item) => item.id === selected.asr);
  const tts = profiles.find((item) => item.id === selected.tts);
  return {
    state: 'ready', mount: 'ready', revision: root.revision, active: selected, profiles,
    llm: llm?.driver === 'deepseek'
      ? { provider: 'deepseek', profile: llm.id, model: llm.model }
      : { provider: 'cpa', profile: null, model: cpaModel() },
    asr: asr?.driver === 'doubao_asr' ? { provider: 'doubao_asr', profile: asr.id } : { provider: 'feiniu-zh', profile: null },
    tts: tts?.driver === 'doubao_tts' || tts?.driver === 'xfyun_tts'
      ? { provider: tts.driver, profile: tts.id }
      : { provider: 'feiniu-voices', profile: null },
  };
}

function load(): Snap {
  const path = process.env.PERSONAL_PROVIDERS_FILE;
  if (!path) return fallback('absent', 'unset');
  const mount = mountOf(path);
  let text: string;
  try {
    const info = statSync(path);
    if (!info.isFile()) return fallback('invalid', mount, 'io');
    if (info.size > MAX_BYTES) return fallback('invalid', mount, 'size');
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fallback('absent', mount);
    return fallback('invalid', mount, 'io');
  }
  if (Buffer.byteLength(text) > MAX_BYTES) return fallback('invalid', mount, 'size');
  const hash = createHash('sha256').update(text).digest('hex');
  if (cache?.path === path && cache.hash === hash) return cache.snap;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fallback('invalid', mount, 'json'); }
  const snap = interpretProviders(raw);
  if (!snap) return fallback('invalid', mount, 'schema');
  snap.mount = mount;
  const active = snap.profiles.find((item) => item.id === snap.active.llm && item.driver === 'deepseek');
  snap.profiles = snap.profiles.map((item) => item.id === active?.id ? item : { ...item, apiKey: undefined });
  cache = { path, hash, snap };
  return snap;
}

export function publicProviderStatus(): ProviderHealth {
  const { profiles, ...health } = load();
  void profiles;
  return health;
}

export function resolvePersonalLlm(): ResolvedLlm {
  const snap = load();
  const selected = snap.profiles.find((item) => item.id === snap.active.llm && item.driver === 'deepseek');
  if (snap.state === 'ready' && selected?.apiKey && selected.model) {
    return { provider: 'deepseek', profile: selected.id, model: selected.model, apiKey: selected.apiKey };
  }
  return { provider: 'cpa' };
}

export type ExtractionTarget = {
  provider: string;
  source: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  extraBody: object;
};

export function extractionTarget(): ExtractionTarget {
  const llm = resolvePersonalLlm();
  if (llm.provider === 'deepseek') {
    return {
      provider: 'deepseek', source: 'personal-providers', apiKey: llm.apiKey,
      baseUrl: DEEPSEEK_CHAT_BASE, model: llm.model, extraBody: {},
    };
  }
  return {
    provider: 'personal', source: 'env', apiKey: process.env.BRAIN_UPSTREAM_API_KEY,
    baseUrl: process.env.BRAIN_UPSTREAM_BASE_URL, model: process.env.BRAIN_UPSTREAM_MODEL ?? '', extraBody: {},
  };
}

type Cpa = { url: string; apiKey: string; model: string };
export type PlannedRequest = { url: string; apiKey: string; body: Record<string, unknown> };

export function planChat(payload: Record<string, unknown>, llm: ResolvedLlm, cpa: Cpa): PlannedRequest {
  if (llm.provider === 'deepseek') {
    return { url: DEEPSEEK_CHAT_URL, apiKey: llm.apiKey, body: { ...payload, model: llm.model } };
  }
  const { thinking, ...rest } = payload;
  void thinking;
  return { url: cpa.url, apiKey: cpa.apiKey, body: { ...rest, model: cpa.model } };
}

export function planResponses(payload: Record<string, unknown>, cpa: Cpa): PlannedRequest {
  return { url: cpa.url, apiKey: cpa.apiKey, body: { ...payload, model: cpa.model } };
}
