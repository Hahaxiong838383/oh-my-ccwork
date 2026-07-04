import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

// 用明文密码 env（不是 bcrypt hash）：
// 原因：Next.js 用 dotenv-expand，会把 hash 里的 $2b$ 当变量展开破坏 hash，
// 单引号 / 双引号都不能完全阻止。改明文 + 文件 chmod 600 + .gitignore 已足够
// 保护个人站后台。安全防线：JWT httpOnly cookie + 7 天过期 + rate limit。

const JWT_SECRET_RAW =
  process.env.ANALYTICS_JWT_SECRET ?? 'dev-secret-please-set-prod-env-min-32-chars-12345'
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW)
const JWT_EXPIRY = '7d' // 7 天后过期，需要重新登录
const COOKIE_NAME = 'cc_admin_session'

export interface AdminClaims {
  username: string
}

// timing-safe string compare 防 timing attack
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

export async function verifyCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  const expectedUser = process.env.ANALYTICS_ADMIN_USERNAME
  const expectedPass = process.env.ANALYTICS_ADMIN_PASSWORD
  if (!expectedUser || !expectedPass) {
    // env 未配置 → 拒绝所有登录（生产环境必须配）
    return false
  }
  return timingSafeEqual(username, expectedUser) && timingSafeEqual(password, expectedPass)
}

export async function signSession(claims: AdminClaims): Promise<string> {
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(JWT_SECRET)
}

export async function verifySession(token: string): Promise<AdminClaims | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET)
    if (typeof payload.username === 'string') {
      return { username: payload.username }
    }
    return null
  } catch {
    return null
  }
}

export const SESSION_COOKIE_NAME = COOKIE_NAME
