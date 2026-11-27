import {request as httpRequest} from 'node:http';

export const NIGHT_BRIDGE_SOCKET = '/run/night-bridge/admin.sock';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_DEVICES = 64;
const MAX_EVENTS = 50;
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ACCENT_RE = /^#[0-9A-Fa-f]{6}$/;
const ALLOWED_ACTIONS = new Set(['sync_logs', 'check_update']);

export class NightBridgeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface DeviceEvent {
  kind: string;
  ts: number;
}

export interface DeviceCommand {
  id: string;
  action: string;
  status: string;
  createdAt: number | null;
  ackedAt: number | null;
}

export interface DeviceSnapshot {
  device: string;
  versionCode: number | string | null;
  phase: string | null;
  muted: boolean | null;
  accent: string | null;
  revision: number | null;
  appliedRevision: number | null;
  lastSeen: number;
  events: DeviceEvent[];
  command: DeviceCommand | null;
}

export function isSameOriginRequest(
  reqUrl: string,
  originHeader: string | undefined,
  fetchSiteHeader: string | undefined,
  talkSiteOrigin?: string,
): boolean {
  if (fetchSiteHeader && fetchSiteHeader !== 'same-origin' && fetchSiteHeader !== 'none') {
    return false;
  }
  if (!originHeader) return true;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(reqUrl).origin);
  } catch {
    return false;
  }
  if (talkSiteOrigin) {
    try {
      allowed.add(new URL(talkSiteOrigin).origin);
    } catch {
      // Ignore malformed optional TALK_SITE_ORIGIN
    }
  }
  return allowed.has(originHeader);
}

export function parseDeviceId(raw: unknown): string {
  if (typeof raw !== 'string' || !DEVICE_ID_RE.test(raw)) {
    throw new NightBridgeError('设备标识无效', 400);
  }
  return raw;
}

export function parseAccent(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new NightBridgeError('颜色须为 #RRGGBB 格式', 400);
  }
  const value = raw.trim();
  if (!ACCENT_RE.test(value)) {
    throw new NightBridgeError('颜色须为 #RRGGBB 格式', 400);
  }
  return value.toUpperCase();
}

export function parseCommandAction(raw: unknown): 'sync_logs' | 'check_update' {
  if (typeof raw !== 'string' || !ALLOWED_ACTIONS.has(raw)) {
    throw new NightBridgeError('不支持的设备指令', 400);
  }
  return raw as 'sync_logs' | 'check_update';
}

function asNonNegInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function asEpochSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizeEvents(raw: unknown): DeviceEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.kind !== 'string' || !entry.kind.trim()) continue;
    const ts = typeof entry.ts === 'number' && Number.isFinite(entry.ts) && entry.ts >= 0 ? entry.ts : 0;
    out.push({kind: entry.kind.trim().slice(0, 120), ts});
    if (out.length >= MAX_EVENTS) break;
  }
  return out;
}

function normalizeCommand(raw: unknown): DeviceCommand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cmd = raw as Record<string, unknown>;
  const action = typeof cmd.action === 'string' ? cmd.action.trim().slice(0, 64) : '';
  if (!action) return null;
  const id = typeof cmd.id === 'string'
    ? cmd.id.trim().slice(0, 128)
    : (typeof cmd.id === 'number' && Number.isFinite(cmd.id) ? String(cmd.id) : '');
  const status = typeof cmd.status === 'string' && cmd.status.trim()
    ? cmd.status.trim().slice(0, 32)
    : 'pending';
  return {
    id,
    action,
    status,
    createdAt: asEpochSeconds(cmd.createdAt),
    ackedAt: asEpochSeconds(cmd.ackedAt),
  };
}

function normalizeDevice(raw: unknown): DeviceSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const device = typeof item.device === 'string' ? item.device.trim() : '';
  if (!device || !DEVICE_ID_RE.test(device)) return null;
  let versionCode: number | string | null = null;
  if (typeof item.versionCode === 'number' && Number.isFinite(item.versionCode) && item.versionCode >= 0) {
    versionCode = Math.trunc(item.versionCode);
  } else if (typeof item.versionCode === 'string' && item.versionCode.trim()) {
    versionCode = item.versionCode.trim().slice(0, 64);
  }
  const phase = typeof item.phase === 'string' && item.phase.trim() ? item.phase.trim().slice(0, 64) : null;
  const muted = typeof item.muted === 'boolean' ? item.muted : null;
  const accent = typeof item.accent === 'string' && ACCENT_RE.test(item.accent.trim())
    ? item.accent.trim().toUpperCase()
    : null;
  const lastSeen = asEpochSeconds(item.lastSeen) ?? 0;
  return {
    device,
    versionCode,
    phase,
    muted,
    accent,
    revision: asNonNegInt(item.revision),
    appliedRevision: asNonNegInt(item.appliedRevision),
    lastSeen,
    events: normalizeEvents(item.events),
    command: normalizeCommand(item.command),
  };
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function bridgeRequest(
  socketPath: string,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const headers: Record<string, string | number> = {
    Host: 'localhost',
    Accept: 'application/json',
    Connection: 'close',
  };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }

  const raw = await new Promise<{status: number; text: string}>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let oversized = false;
    const finish = (err: Error | null, result?: {status: number; text: string}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result!);
    };

    const req = httpRequest({socketPath, path, method, headers}, res => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          oversized = true;
          req.destroy(new Error('oversized'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => {
        if (timedOut) finish(new NightBridgeError('手机桥接服务响应超时', 504));
        else if (oversized) finish(new NightBridgeError('手机桥接服务响应过大', 502));
        else finish(new NightBridgeError('手机桥接服务连接中断', 502));
      });
      res.on('end', () => {
        finish(null, {status: res.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8')});
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error('timeout'));
    }, timeoutMs);

    req.on('error', () => {
      if (timedOut) finish(new NightBridgeError('手机桥接服务响应超时', 504));
      else if (oversized) finish(new NightBridgeError('手机桥接服务响应过大', 502));
      else finish(new NightBridgeError('手机桥接服务暂不可用', 503));
    });

    if (payload) req.write(payload);
    req.end();
  });

  const data = parseJsonObject(raw.text);
  if (raw.status >= 400 && raw.status < 500) {
    const upstreamError = typeof data?.error === 'string' && data.error.trim()
      ? data.error.trim().slice(0, 200)
      : (raw.status === 404 ? '未找到该手机设备' : '设备操作未能完成');
    throw new NightBridgeError(upstreamError, raw.status);
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new NightBridgeError('手机桥接服务响应异常', 502);
  }
  if (!data) {
    throw new NightBridgeError('手机桥接服务返回格式无效', 502);
  }
  return data;
}

export async function getNightDevices(
  socketPath = NIGHT_BRIDGE_SOCKET,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{devices: DeviceSnapshot[]}> {
  const data = await bridgeRequest(socketPath, '/devices', 'GET', undefined, timeoutMs);
  if (!Array.isArray(data.devices)) {
    throw new NightBridgeError('手机桥接服务返回设备列表无效', 502);
  }
  const devices: DeviceSnapshot[] = [];
  for (const item of data.devices) {
    const normalized = normalizeDevice(item);
    if (normalized) devices.push(normalized);
    if (devices.length >= MAX_DEVICES) break;
  }
  return {devices};
}

export async function setDeviceColor(
  socketPath: string,
  rawId: unknown,
  rawAccent: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ok: true}> {
  const id = parseDeviceId(rawId);
  const accent = parseAccent(rawAccent);
  const data = await bridgeRequest(
    socketPath,
    '/devices/' + encodeURIComponent(id) + '/color',
    'POST',
    {accent},
    timeoutMs,
  );
  if (data.ok !== true) {
    const msg = typeof data.error === 'string' && data.error.trim()
      ? data.error.trim().slice(0, 200)
      : '手机桥接服务未确认颜色更新';
    throw new NightBridgeError(msg, 502);
  }
  return {ok: true};
}

export async function sendDeviceCommand(
  socketPath: string,
  rawId: unknown,
  rawAction: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ok: true}> {
  const id = parseDeviceId(rawId);
  const action = parseCommandAction(rawAction);
  const data = await bridgeRequest(
    socketPath,
    '/devices/' + encodeURIComponent(id) + '/command',
    'POST',
    {action},
    timeoutMs,
  );
  if (data.ok !== true) {
    const msg = typeof data.error === 'string' && data.error.trim()
      ? data.error.trim().slice(0, 200)
      : '手机桥接服务未确认指令下发';
    throw new NightBridgeError(msg, 502);
  }
  return {ok: true};
}
