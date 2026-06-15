import { jwtVerify } from 'jose';

// Step 4：WS 握手鉴权用的 JWT 验证。
// secret 必须与 routes/invite-auth.ts 的 SignJWT 一致（同 env + 同 fallback）。
// 浏览器原生 WS 不能加 Authorization header → token 走 query（?token=<JWT>）。
const SECRET = new TextEncoder().encode(process.env.AUTH_JWT_SECRET || 'dev-secret-change-me');

export type AuthContext = {
  accountId: string;
  role: string;
};

/**
 * 验证邀请码登录 JWT。
 * - 有效 → 返回 AuthContext{accountId, role}
 * - 无 token / 无效 / 过期 → 返回 null（调用方据此退回现有匿名行为，向后兼容）
 */
export async function verifyAuthToken(token: string | null | undefined): Promise<AuthContext | null> {
  if (!token || !token.trim()) return null;
  try {
    const { payload } = await jwtVerify(token.trim(), SECRET, {
      issuer: 'p003',
      audience: 'kidshub',
    });
    const accountId = typeof payload.accountId === 'string' && payload.accountId.trim() ? payload.accountId : null;
    if (!accountId) return null;
    const role = typeof payload.role === 'string' && payload.role ? payload.role : 'parent';
    return { accountId, role };
  } catch {
    // 验证失败（签名错/过期/格式错）一律当匿名，不抛错（不破坏现有匿名连接）
    return null;
  }
}
