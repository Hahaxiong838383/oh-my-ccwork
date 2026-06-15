// 家长端 → 后端 API（建档 + 配网设备绑定）。
// 原型阶段用固定测试账号 KH-9K2M 自动登录拿 JWT（后续接真实邀请码登录页替换 DEMO_CODE）。
// 走 vite proxy /api → 后端 server。

const TOKEN_KEY = 'parent.token';
const DEMO_CODE = 'KH-9K2M';

async function login(): Promise<string> {
  const res = await fetch('/api/auth/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: DEMO_CODE }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const data = (await res.json()) as { token?: string };
  const token = data.token ?? '';
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  return token;
}

async function getToken(): Promise<string> {
  const cached = sessionStorage.getItem(TOKEN_KEY);
  return cached || login();
}

async function authedPost(path: string, body: unknown): Promise<unknown> {
  let token = await getToken();
  const send = (t: string) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    });

  let res = await send(token);
  // token 失效(401) → 清缓存重登一次再试
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    token = await login();
    res = await send(token);
  }
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

export function saveProfile(input: { nickname: string; birthday: string; gender: string }): Promise<unknown> {
  return authedPost('/api/profile', input);
}

export function bindDevice(input: { model: string; name: string }): Promise<unknown> {
  return authedPost('/api/profile/device', input);
}
