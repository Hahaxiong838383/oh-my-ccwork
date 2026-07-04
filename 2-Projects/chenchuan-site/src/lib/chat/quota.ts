import 'server-only'
import { createHash } from 'node:crypto'
import { getDb } from '@/lib/analytics/db'

export const CHAT_QUOTA_LIMIT = 3

export interface QuotaStatus {
  count: number
  remaining: number
}

function getMonthSalt(): string {
  return new Date().toISOString().slice(0, 7)
}

export function hashIp(ip: string): string {
  const secret = process.env.ANALYTICS_HASH_SECRET ?? 'default-salt-please-set-env'
  return createHash('sha256').update(`${ip}|${getMonthSalt()}|${secret}`).digest('hex').slice(0, 32)
}

export function resolveClientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    'unknown'
  )
}

export function getQuotaStatus(cookieId: string, ipHash: string): QuotaStatus {
  const db = getDb()
  const row = db
    .prepare('SELECT count FROM chat_quota WHERE cookie_id = ? AND ip_hash = ?')
    .get(cookieId, ipHash) as { count: number } | undefined

  const count = row?.count ?? 0
  return {
    count,
    remaining: Math.max(0, CHAT_QUOTA_LIMIT - count),
  }
}

export function consumeQuota(cookieId: string, ipHash: string, now = Date.now()): QuotaStatus {
  const db = getDb()

  db.prepare(
    `INSERT INTO chat_quota (cookie_id, ip_hash, count, first_at, last_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(cookie_id, ip_hash)
     DO UPDATE SET
       count = chat_quota.count + 1,
       last_at = excluded.last_at`,
  ).run(cookieId, ipHash, now, now)

  return getQuotaStatus(cookieId, ipHash)
}
