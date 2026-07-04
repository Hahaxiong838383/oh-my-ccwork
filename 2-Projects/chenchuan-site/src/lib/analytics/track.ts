import 'server-only'
import { createHash } from 'node:crypto'
import { getDb } from './db'

// IP hash：sha256(ip + 月度盐)，UV 能算但 IP 不可逆
// 月度盐：YYYY-MM + ANALYTICS_HASH_SECRET（env），每月轮换
function hashIp(ip: string): string {
  const monthSalt = new Date().toISOString().slice(0, 7) // YYYY-MM
  const secret = process.env.ANALYTICS_HASH_SECRET ?? 'default-salt-please-set-env'
  return createHash('sha256').update(`${ip}|${monthSalt}|${secret}`).digest('hex').slice(0, 32)
}

interface TrackInput {
  path: string
  referrer: string | null
  ip: string
  ua: string | null
  country: string | null
}

// 记录一次访问。任何失败都吞掉，确保主站不受影响。
export function trackVisit(input: TrackInput): void {
  try {
    const db = getDb()
    const stmt = db.prepare(
      'INSERT INTO visits (ts, path, referrer, ip_hash, ip, ua, country) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    stmt.run(
      Date.now(),
      input.path.slice(0, 256), // 防 path 异常长
      input.referrer ? input.referrer.slice(0, 256) : null,
      hashIp(input.ip),
      input.ip.slice(0, 64), // 明文 IP（IPv6 最长 39，留余量）
      input.ua ? input.ua.slice(0, 256) : null,
      input.country,
    )
  } catch (err) {
    // 静默失败：访问记录绝不能影响主站可用性
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('[analytics] track failed:', err)
    }
  }
}
