// 家长端 → 后端 API（登录态 + 建档/配网写入 + 读档案/设备）。
// token 由 InviteLoginPage 登录后存 sessionStorage 'parent.token'；本模块只读取，不再自动登录。
// 走 vite proxy /api → 后端 server。

const TOKEN_KEY = 'parent.token';

export type Profile = { id: string; nickname: string; birthday: string; gender: string };
export type DeviceInfo = { id: string; model: string; name: string };

function getToken(): string {
  const t = sessionStorage.getItem(TOKEN_KEY);
  if (!t) throw new Error('not logged in');
  return t;
}

async function authed(path: string, init?: RequestInit): Promise<unknown> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY); // token 过期/失效 → 清除，下次启动回登录页
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

function post(path: string, body: unknown): Promise<unknown> {
  return authed(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export function saveProfile(input: { nickname: string; birthday: string; gender: string }): Promise<unknown> {
  return post('/api/profile', input);
}

export function bindDevice(input: { model: string; name: string }): Promise<unknown> {
  return post('/api/profile/device', input);
}

export function getProfile(): Promise<{ ok: boolean; profile: Profile | null }> {
  return authed('/api/profile') as Promise<{ ok: boolean; profile: Profile | null }>;
}

export function getDevice(): Promise<{ ok: boolean; device: DeviceInfo | null }> {
  return authed('/api/profile/device') as Promise<{ ok: boolean; device: DeviceInfo | null }>;
}

export type BindSnResult = { ok: boolean; message?: string; brain_opened?: boolean };

/** 硬件 SN 绑定（绑定即接入大脑）。失败返回 {ok:false, message}（409 已被绑/404 台账外），不抛错。 */
export async function bindSn(sn: string): Promise<BindSnResult> {
  const token = getToken();
  const res = await fetch('/api/profile/bind-sn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sn }),
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new Error('unauthorized');
  }
  const data = (await res.json().catch(() => ({}))) as BindSnResult & { error?: string };
  if (res.ok && data.ok) return data;
  return { ok: false, message: data.message ?? '绑定失败，请稍后再试' };
}

// ── 配网 v2（nonce 桥，联调合同 CC_P003_PAIRING_V4 + codex 开工 prompt 2026-08-22）──
// confirm：把设备屏二维码里的 SN+nonce+pk 与当前家长账号一次性关联；
// status：轮询设备 claim 进度。结构化错误不抛（页面按 code 分支文案）。

export type ConfirmResult = { ok: boolean; session_id?: string; error?: string };
export async function confirmPairing(sn: string, nonce: string, pk: string): Promise<ConfirmResult> {
  const token = getToken();
  const res = await fetch('/api/parent/pairing/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sn, nonce, pk, pairing_protocol: 2 }),
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new Error('unauthorized');
  }
  return (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as ConfirmResult;
}

export type PairingState = 'pending' | 'bound' | 'initializing' | 'expired';
export async function getPairingStatus(sessionId: string): Promise<{ ok: boolean; state?: PairingState; sn?: string }> {
  const token = getToken();
  const res = await fetch(`/api/parent/pairing/status?session_id=${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new Error('unauthorized');
  }
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; state?: PairingState; sn?: string };
}
