import {randomBytes} from 'node:crypto';
import {closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync} from 'node:fs';
import {dirname, join} from 'node:path';

const MAX_BYTES = 262144;
const MAX_PROFILES = 32;
const ASR_URLS = [
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_RE = /^[\x21-\x7e]{8,512}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ProviderError extends Error {
  status: number;
  revision?: number;
  constructor(message: string, status: number, revision?: number) {
    super(message);
    this.status = status;
    this.revision = revision;
  }
}

type Kind = 'llm' | 'asr' | 'tts';
type StringMap = Record<string, string>;
interface Profile {
  id: string;
  kind: Kind;
  driver: string;
  name: string;
  config: StringMap;
  secrets: StringMap;
  [key: string]: unknown;
}
interface Active {llm: string | null; asr: string | null; tts: string | null}
interface Document {
  version: 1;
  revision: number;
  profiles: Profile[];
  active: Active;
  [key: string]: unknown;
}
interface FieldSpec {
  key: string;
  required?: boolean;
  label: string;
  pattern?: RegExp;
  options?: {value: string; label: string}[];
}
interface DriverSpec {
  kind: Kind;
  label: string;
  note: string;
  config: FieldSpec[];
  secrets: FieldSpec[];
  authorize?: (secrets: StringMap) => void;
}

const speed = {key: 'VOLC_TTS_SPEED', label: '语速', pattern: /^(?:0\.[5-9]\d?|1(?:\.\d{1,2})?|2(?:\.0{1,2})?)$/};
const drivers: Record<string, DriverSpec> = {
  deepseek: {
    kind: 'llm', label: 'DeepSeek', note: '只连接官方 https://api.deepseek.com，不能填写其他地址',
    config: [{key: 'DEEPSEEK_MODEL', required: true, label: '模型', pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/}],
    secrets: [{key: 'DEEPSEEK_API_KEY', required: true, label: 'API Key'}],
  },
  doubao_asr: {
    kind: 'asr', label: '豆包识别', note: '填写应用 ID 与访问令牌，或只填写识别 API Key',
    config: [
      {key: 'VOLC_ASR_RESOURCE_ID', required: true, label: '资源 ID', pattern: TOKEN_RE},
      {key: 'VOLC_ASR_END_WINDOW_MS', label: '断句静音窗口（毫秒）', pattern: /^[1-9]\d{0,4}$/},
      {key: 'VOLC_ASR_ENABLE_DDC', label: '识别结果顺滑', options: [
        {value: '', label: '默认'}, {value: '1', label: '开启'}, {value: '0', label: '关闭'},
      ]},
      {key: 'VOLC_ASR_URL', label: '识别地址', options: [
        {value: '', label: '官方默认'},
        {value: ASR_URLS[0], label: 'bigmodel'},
        {value: ASR_URLS[1], label: 'bigmodel_async'},
      ]},
    ],
    secrets: [
      {key: 'VOLC_APP_ID', label: '应用 ID'},
      {key: 'VOLC_ACCESS_TOKEN', label: '访问令牌'},
      {key: 'VOLC_ASR_API_KEY', label: '识别 API Key'},
    ],
    authorize(secrets) {
      const pair = Boolean(secrets.VOLC_APP_ID && secrets.VOLC_ACCESS_TOKEN);
      if (!pair && !secrets.VOLC_ASR_API_KEY) throw new ProviderError('需要应用 ID 与访问令牌，或识别 API Key', 400);
    },
  },
  doubao_tts: {
    kind: 'tts', label: '豆包合成', note: '启用后，通话使用这里的云端音色；飞牛五音色保留为内置回退',
    config: [
      {key: 'VOLC_TTS_RESOURCE_ID', required: true, label: '资源 ID', pattern: TOKEN_RE},
      {key: 'VOLC_TTS_SPEAKER', required: true, label: '音色', pattern: TOKEN_RE},
      speed,
    ],
    secrets: [
      {key: 'VOLC_APP_ID', required: true, label: '应用 ID'},
      {key: 'VOLC_ACCESS_TOKEN', required: true, label: '访问令牌'},
    ],
  },
  xfyun_tts: {
    kind: 'tts', label: '讯飞合成', note: '启用后，通话使用这里的云端音色；飞牛五音色保留为内置回退',
    config: [
      {key: 'XFYUN_TTS_VCN', required: true, label: '音色', pattern: TOKEN_RE},
      {key: 'XFYUN_TTS_SPEED', label: '语速', pattern: /^(?:100|[1-9]?\d)$/},
      {key: 'XFYUN_TTS_ORAL_LEVEL', label: '口语化', options: [
        {value: '', label: '默认'}, {value: 'low', label: '低'}, {value: 'mid', label: '中'}, {value: 'high', label: '高'},
      ]},
      {key: 'XFYUN_TTS_PRECONNECT', label: '预连接', options: [
        {value: '', label: '默认'}, {value: '1', label: '开启'}, {value: '0', label: '关闭'},
      ]},
    ],
    secrets: [
      {key: 'XFYUN_TTS_APP_ID', required: true, label: '应用 ID'},
      {key: 'XFYUN_TTS_API_KEY', required: true, label: 'API Key'},
      {key: 'XFYUN_TTS_API_SECRET', required: true, label: 'API Secret'},
    ],
  },
};

const fallback = {llm: '个人 CPA', asr: '飞牛中文识别', tts: '飞牛五音色'};

function fail(message: string, status: number, revision?: number): never {
  throw new ProviderError(message, status, revision);
}

function stringMap(value: unknown, mode: 'read' | 'write'): StringMap {
  const invalid = mode === 'read' ? ['供应商文件无法读取', 503] as const : ['请求无效', 400] as const;
  if (value == null) return Object.create(null);
  if (typeof value !== 'object' || Array.isArray(value)) fail(invalid[0], invalid[1]);
  const out: StringMap = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!ENV_RE.test(key) || typeof item !== 'string' || item.length > 4096) fail(invalid[0], invalid[1]);
    if (mode === 'write' && item.includes('://') && !ASR_URLS.includes(item as typeof ASR_URLS[number])) fail('不接受自定义接口地址', 400);
    out[key] = item;
  }
  return out;
}

function cleanName(value: unknown) {
  if (typeof value !== 'string') fail('请填写名称', 400);
  const name = value.trim();
  if (name.length < 1 || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) fail('请填写名称', 400);
  return name;
}

function checkValue(spec: FieldSpec, value: string) {
  if (spec.options) {
    if (!spec.options.some(item => item.value === value)) fail('请求无效', 400);
    return;
  }
  if (spec.pattern && !spec.pattern.test(value)) fail('请求无效', 400);
  if (value.includes('://')) fail('不接受自定义接口地址', 400);
}

function applyFields(spec: DriverSpec, current: Profile | undefined, configIn: StringMap, secretsIn: StringMap): Pick<Profile, 'config' | 'secrets'> {
  const config: StringMap = Object.create(null);
  const secrets: StringMap = Object.create(null);
  if (current) {
    Object.assign(config, current.config);
    Object.assign(secrets, current.secrets);
  }
  const knownConfig = new Set(spec.config.map(item => item.key));
  const knownSecret = new Set(spec.secrets.map(item => item.key));
  for (const key of Object.keys(configIn)) if (!knownConfig.has(key)) fail('不接受该配置项', 400);
  for (const key of Object.keys(secretsIn)) if (!knownSecret.has(key)) fail('不接受该配置项', 400);
  for (const field of spec.config) {
    const value = configIn[field.key];
    if (value == null) continue;
    if (value === '') {
      if (field.required) fail('请填写' + field.label, 400);
      delete config[field.key];
      continue;
    }
    checkValue(field, value);
    config[field.key] = value;
  }
  for (const field of spec.secrets) {
    const value = secretsIn[field.key];
    if (value == null || value === '') continue;
    if (!SECRET_RE.test(value) || value.includes('://')) fail('密钥格式无效', 400);
    secrets[field.key] = value;
  }
  for (const field of spec.config) if (field.required && !config[field.key]) fail('请填写' + field.label, 400);
  for (const field of spec.secrets) if (field.required && !secrets[field.key]) fail('请填写' + field.label, 400);
  spec.authorize?.(secrets);
  return {config, secrets};
}

function emptyDocument(): Document {
  return {version: 1, revision: 0, profiles: [], active: {llm: null, asr: null, tts: null}};
}

function kindOf(value: unknown): Kind | null {
  return value === 'llm' || value === 'asr' || value === 'tts' ? value : null;
}

function readActive(value: unknown): Active {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) fail('供应商文件无法读取', 503);
  const active = value as Record<string, unknown>;
  const out: Active = {llm: null, asr: null, tts: null};
  for (const kind of ['llm', 'asr', 'tts'] as const) {
    const id = active[kind];
    if (id == null) out[kind] = null;
    else if (typeof id === 'string' && ID_RE.test(id)) out[kind] = id;
    else fail('供应商文件无法读取', 503);
  }
  return out;
}

function readProfile(value: unknown): Profile {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) fail('供应商文件无法读取', 503);
  const item = value as Record<string, unknown>;
  const driver = typeof item.driver === 'string' ? item.driver : '';
  const known = drivers[driver];
  const kind = kindOf(item.kind);
  if (!known || kind !== known.kind || typeof item.id !== 'string' || !ID_RE.test(item.id) || item.id === 'active') fail('供应商文件无法读取', 503);
  const profile: Profile = {
    ...item,
    id: item.id,
    kind,
    driver,
    name: cleanStoredName(item.name),
    config: stringMap(item.config ?? {}, 'read'),
    secrets: stringMap(item.secrets ?? {}, 'read'),
  };
  return profile;
}

function cleanStoredName(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) fail('供应商文件无法读取', 503);
  return value;
}

export function readDocument(file: string): {doc: Document; persisted: boolean} {
  let stat;
  try { stat = statSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {doc: emptyDocument(), persisted: false};
    fail('供应商文件无法读取', 503);
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('供应商文件无法读取', 503);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('供应商文件无法读取', 503); }
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) fail('供应商文件无法读取', 503);
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) fail('供应商文件无法读取', 503);
  if (!Array.isArray(raw.profiles) || raw.profiles.length > MAX_PROFILES) fail('供应商文件无法读取', 503);
  const profiles = raw.profiles.map(readProfile);
  if (new Set(profiles.map(item => item.id)).size !== profiles.length) fail('供应商文件无法读取', 503);
  return {doc: {...raw, version: 1, revision: raw.revision as number, profiles, active: readActive(raw.active)}, persisted: true};
}

function publicProfile(profile: Profile) {
  const spec = drivers[profile.driver];
  const allowed = new Set(spec.config.map(item => item.key));
  const secretValues = new Set(Object.values(profile.secrets));
  const name = secretValues.has(profile.name) ? '（名称已隐藏）' : profile.name;
  const config: StringMap = {};
  for (const field of spec.config) {
    const value = profile.config[field.key];
    if (typeof value === 'string' && value && !secretValues.has(value)) config[field.key] = value;
  }
  for (const key of Object.keys(config)) if (!allowed.has(key)) delete config[key];
  const secrets: Record<string, boolean> = {};
  for (const field of spec.secrets) secrets[field.key] = Boolean(profile.secrets[field.key]);
  return {id: profile.id, kind: profile.kind, driver: profile.driver, name, config, secrets};
}

export function publicFields() {
  return Object.fromEntries(Object.entries(drivers).map(([driver, spec]) => [driver, {
    kind: spec.kind,
    label: spec.label,
    note: spec.note,
    config: spec.config.map(({key, required, label, options}) => ({key, required: Boolean(required), label, options})),
    secrets: spec.secrets.map(({key, required, label}) => ({key, required: Boolean(required), label})),
  }]));
}

export function publicView(doc: Document, persisted: boolean) {
  return {
    version: 1 as const,
    revision: doc.revision,
    persisted,
    profiles: doc.profiles.map(publicProfile),
    active: {...doc.active},
    fallback,
    fields: publicFields(),
  };
}

function expectRevision(doc: Document, value: unknown) {
  if (value !== doc.revision) fail('供应商配置已更新，请刷新后再保存', 409, doc.revision);
}

function idle(ready: boolean) {
  if (!ready) fail('请在 Worker 已注册且通话全部结束后再改已选供应商', 409);
}

function selected(doc: Document, id: string) {
  return Object.values(doc.active).includes(id);
}

export function createProfile(doc: Document, body: Record<string, unknown>): Document {
  expectRevision(doc, body.revision);
  const spec = drivers[String(body.driver)];
  if (!spec || body.kind !== spec.kind) fail('类型与驱动不匹配', 400);
  if (doc.profiles.length >= MAX_PROFILES) fail('已达到供应商数量上限', 400);
  const fields = applyFields(spec, undefined, stringMap(body.config, 'write'), stringMap(body.secrets, 'write'));
  if (Object.values(fields.secrets).includes(cleanName(body.name))) fail('名称不能与密钥相同', 400);
  let id = '';
  const used = new Set(doc.profiles.map(item => item.id));
  do { id = 'p' + randomBytes(8).toString('hex'); } while (used.has(id));
  return {...doc, revision: doc.revision + 1, profiles: [...doc.profiles, {id, kind: spec.kind, driver: String(body.driver), name: cleanName(body.name), ...fields}]};
}

export function updateProfile(doc: Document, id: string, body: Record<string, unknown>, ready: boolean): Document {
  expectRevision(doc, body.revision);
  const index = doc.profiles.findIndex(item => item.id === id);
  if (index < 0) fail('无此供应商', 404);
  const current = doc.profiles[index];
  if (body.kind !== current.kind || body.driver !== current.driver) fail('类型与驱动不匹配', 400);
  const spec = drivers[current.driver];
  const fields = applyFields(spec, current, stringMap(body.config, 'write'), stringMap(body.secrets, 'write'));
  if (Object.values(fields.secrets).includes(cleanName(body.name))) fail('名称不能与密钥相同', 400);
  const nextProfile = {...current, name: cleanName(body.name), ...fields};
  if (JSON.stringify({name: current.name, config: current.config, secrets: current.secrets}) === JSON.stringify({name: nextProfile.name, config: nextProfile.config, secrets: nextProfile.secrets})) return doc;
  if (selected(doc, id)) idle(ready);
  const profiles = doc.profiles.slice();
  profiles[index] = nextProfile;
  return {...doc, revision: doc.revision + 1, profiles};
}

export function activateProfile(doc: Document, kind: string, body: Record<string, unknown>, ready: boolean): Document {
  expectRevision(doc, body.revision);
  const slot = kindOf(kind);
  if (!slot) fail('无此类型', 404);
  const id = body.id;
  if (id !== null && (typeof id !== 'string' || !doc.profiles.some(item => item.id === id && item.kind === slot))) fail('请选择同类型的供应商', 400);
  if (doc.active[slot] === id) return doc;
  idle(ready);
  return {...doc, revision: doc.revision + 1, active: {...doc.active, [slot]: id}};
}

function commit(file: string, doc: Document) {
  const dir = dirname(file);
  const tmp = join(dir, '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp');
  const payload = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
  if (payload.length > MAX_BYTES) fail('配置文件已达到容量上限', 400);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < payload.length) offset += writeSync(fd, payload, offset);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    fail('供应商文件无法写入', 503);
  }
  closeSync(fd);
  try { renameSync(tmp, file); } catch {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    fail('供应商文件无法写入', 503);
  }
  try {
    const dirfd = openSync(dir, 'r');
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  } catch { fail('配置已替换，目录同步失败，请重新加载确认', 503); }
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) fail('供应商文件权限不正确', 503);
}

let queue: Promise<unknown> = Promise.resolve();

export function withProviders<T>(file: string, change: (doc: Document) => Document | null): Promise<T> {
  const run = queue.then(() => {
    const loaded = readDocument(file);
    const next = change(loaded.doc);
    if (next && next !== loaded.doc) {
      const again = readDocument(file);
      if (again.persisted !== loaded.persisted || again.doc.revision !== loaded.doc.revision) fail('供应商配置已更新，请刷新后再保存', 409, again.doc.revision);
      commit(file, next);
    }
    const stored = readDocument(file);
    return publicView(stored.doc, stored.persisted) as T;
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
