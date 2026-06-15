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
