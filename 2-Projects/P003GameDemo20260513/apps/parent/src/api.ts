// 家长端 → 后端 API（登录态 + 建档/配网写入 + 读档案/设备）。
// token 统一由本模块管理，存 localStorage 'parent.token'（持久登录，关页不丢——
// 川哥 2026-08-23「自动记住认证信息，避免每次都要发短信/填邀请码」）。
// 走 vite proxy /api → 后端 server。

const TOKEN_KEY = 'parent.token';

export type Profile = { id: string; nickname: string; birthday: string; gender: string };
export type DeviceInfo = { id: string; model: string; name: string };

/** 登录成功后保存 token（InviteLoginPage 两条登录链路共用）。 */
export function saveAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY); // 旧版本存这里，一并清防残留
}

/** JWT exp 已过或格式坏 → true（payload 是 base64url 无 padding，atob 前须补齐）。 */
function tokenExpired(t: string): boolean {
  try {
    const b64 = (t.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

/** 启动时判断登录态：本地有未过期 token 才算已登录；过期/坏 token 当场清掉。 */
export function hasValidToken(): boolean {
  // 旧版本存 sessionStorage：刷新升级的页面顺手迁移，免一次重登
  const legacy = sessionStorage.getItem(TOKEN_KEY);
  if (legacy && !localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, legacy);
  sessionStorage.removeItem(TOKEN_KEY);
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return false;
  if (tokenExpired(t)) {
    clearAuthToken();
    return false;
  }
  return true;
}

function getToken(): string {
  const t = localStorage.getItem(TOKEN_KEY);
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
    clearAuthToken(); // token 过期/失效 → 清除，下次启动回登录页
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
    clearAuthToken();
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
    clearAuthToken();
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
    clearAuthToken();
    throw new Error('unauthorized');
  }
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; state?: PairingState; sn?: string };
}
