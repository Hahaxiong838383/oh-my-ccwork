import 'server-only'
import { getDb } from '@/lib/analytics/db'

export type BlacklistReason = 'burst_10min' | 'sustained_1h'

export const BURST_WINDOW_MS = 10 * 60 * 1000
export const BURST_THRESHOLD_CENTS = 200
export const SUSTAINED_WINDOW_MS = 60 * 60 * 1000
export const SUSTAINED_THRESHOLD_CENTS = 150
const BAN_DURATION_MS = 24 * 60 * 60 * 1000

interface UsageEvent {
  ts: number
  cents: number
}

const usageMap = new Map<string, UsageEvent[]>()

function getRecentEvents(ipHash: string, now: number): UsageEvent[] {
  const events = usageMap.get(ipHash) ?? []
  const filtered = events.filter((item) => now - item.ts <= SUSTAINED_WINDOW_MS)
  usageMap.set(ipHash, filtered)
  return filtered
}

function sumWindow(events: UsageEvent[], now: number, windowMs: number): number {
  let total = 0
  for (const event of events) {
    if (now - event.ts <= windowMs) {
      total += event.cents
    }
  }
  return total
}

export function isIpBlacklisted(
  ipHash: string,
  now = Date.now(),
): { blacklisted: boolean; reason?: BlacklistReason | string; expiresAt?: number } {
  const db = getDb()
  const row = db
    .prepare('SELECT reason, expires_at FROM chat_blacklist WHERE ip_hash = ?')
    .get(ipHash) as { reason: string | null; expires_at: number } | undefined

  if (!row) {
    return { blacklisted: false }
  }

  if (row.expires_at <= now) {
    db.prepare('DELETE FROM chat_blacklist WHERE ip_hash = ?').run(ipHash)
    return { blacklisted: false }
  }

  return {
    blacklisted: true,
    reason: row.reason ?? 'unknown',
    expiresAt: row.expires_at,
  }
}

export function banIp(ipHash: string, reason: BlacklistReason, now = Date.now()): number {
  const expiresAt = now + BAN_DURATION_MS
  const db = getDb()
  db.prepare(
    `INSERT INTO chat_blacklist (ip_hash, reason, banned_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip_hash)
     DO UPDATE SET
       reason = excluded.reason,
       banned_at = excluded.banned_at,
       expires_at = excluded.expires_at`,
  ).run(ipHash, reason, now, expiresAt)
  return expiresAt
}

export function getUsageWindows(
  ipHash: string,
  now = Date.now(),
): { burst10MinCents: number; sustained1hCents: number } {
  const events = getRecentEvents(ipHash, now)
  return {
    burst10MinCents: sumWindow(events, now, BURST_WINDOW_MS),
    sustained1hCents: sumWindow(events, now, SUSTAINED_WINDOW_MS),
  }
}

export function recordUsageAndCheck(
  ipHash: string,
  cents: number,
  now = Date.now(),
): {
  burst10MinCents: number
  sustained1hCents: number
  burstExceeded: boolean
  sustainedExceeded: boolean
} {
  const events = getRecentEvents(ipHash, now)
  events.push({ ts: now, cents })
  usageMap.set(ipHash, events)

  const burst10MinCents = sumWindow(events, now, BURST_WINDOW_MS)
  const sustained1hCents = sumWindow(events, now, SUSTAINED_WINDOW_MS)

  return {
    burst10MinCents,
    sustained1hCents,
    burstExceeded: burst10MinCents > BURST_THRESHOLD_CENTS,
    sustainedExceeded: sustained1hCents > SUSTAINED_THRESHOLD_CENTS,
  }
}
