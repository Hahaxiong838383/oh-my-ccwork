import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getDb } from '@/lib/analytics/db'

export const VOICE_BROWSER_DAILY_LIMIT = 1
export const VOICE_IP_DAILY_LIMIT = 2
export const VOICE_DEFAULT_SECONDS = 120

type SessionSource = 'daily' | 'code'

interface UsageRow {
  count: number
}

interface CodeRow {
  code_hash: string
  max_uses: number
  used_count: number
  expires_at: number
  revoked_at: number | null
}

interface SessionRow {
  id: string
  visitor_id: string
  cookie_hash: string
  ip_hash: string
  source: SessionSource
  code_hash: string | null
  status: string
  expires_at: number
}

export interface VoiceQuotaStatus {
  visitorId: string
  remaining: number
  browserUsed: number
  ipUsed: number
  maxSeconds: number
}

export interface VoiceReservation {
  id: string
  visitorId: string
  source: SessionSource
  cookieHash: string
}

export interface VoiceExperienceCode {
  codeHint: string
  label: string | null
  maxUses: number
  usedCount: number
  expiresAt: number
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

function chinaDate(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '')
}

export function voiceCookieHash(cookieId: string): string {
  return sha256(`voice-cookie:${cookieId}`)
}

export function voiceVisitorId(cookieId: string): string {
  return `V-${voiceCookieHash(cookieId).slice(0, 10).toUpperCase()}`
}

function codeHash(code: string): string {
  return sha256(`voice-code:${normalizeCode(code)}`)
}

function codeIsUsable(row: CodeRow | undefined, now: number): row is CodeRow {
  return Boolean(row && !row.revoked_at && row.expires_at > now && row.used_count < row.max_uses)
}

function cleanupExpiredSessions(now: number): void {
  getDb()
    .prepare(
      `UPDATE voice_experience_sessions
       SET status = 'expired', stopped_at = ?
       WHERE status IN ('reserved', 'active') AND expires_at <= ?`,
    )
    .run(now, now)
}

export function getVoiceQuota(cookieId: string, ipHash: string, now = Date.now()): VoiceQuotaStatus {
  const db = getDb()
  const date = chinaDate(now)
  const visitorId = voiceVisitorId(cookieId)
  const browser = db
    .prepare('SELECT count FROM voice_experience_usage WHERE visitor_id = ? AND date = ?')
    .get(visitorId, date) as UsageRow | undefined
  const ip = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS count FROM voice_experience_usage WHERE ip_hash = ? AND date = ?')
    .get(ipHash, date) as UsageRow
  const browserUsed = browser?.count ?? 0
  const ipUsed = ip?.count ?? 0
  return {
    visitorId,
    remaining:
      browserUsed < VOICE_BROWSER_DAILY_LIMIT && ipUsed < VOICE_IP_DAILY_LIMIT ? 1 : 0,
    browserUsed,
    ipUsed,
    maxSeconds: Number(process.env.PUBLIC_VOICE_MAX_SECONDS ?? VOICE_DEFAULT_SECONDS),
  }
}

export function reserveVoiceExperience(
  cookieId: string,
  ipHash: string,
  experienceCode?: string,
  now = Date.now(),
): VoiceReservation {
  const db = getDb()
  const visitorId = voiceVisitorId(cookieId)
  const cookieHash = voiceCookieHash(cookieId)
  const normalizedCode = experienceCode ? normalizeCode(experienceCode) : ''

  return db.transaction(() => {
    cleanupExpiredSessions(now)
    const existing = db
      .prepare(
        `SELECT id FROM voice_experience_sessions
         WHERE visitor_id = ? AND status IN ('reserved', 'active') AND expires_at > ? LIMIT 1`,
      )
      .get(visitorId, now)
    if (existing) throw new Error('voice_session_already_active')

    let source: SessionSource = 'daily'
    let selectedCodeHash: string | null = null
    if (normalizedCode) {
      selectedCodeHash = codeHash(normalizedCode)
      const row = db
        .prepare('SELECT * FROM voice_experience_codes WHERE code_hash = ?')
        .get(selectedCodeHash) as CodeRow | undefined
      if (!codeIsUsable(row, now)) throw new Error('invalid_experience_code')
      source = 'code'
    } else {
      const quota = getVoiceQuota(cookieId, ipHash, now)
      if (quota.remaining <= 0) throw new Error('voice_quota_exceeded')
    }

    const id = randomUUID()
    db.prepare(
      `INSERT INTO voice_experience_sessions
       (id, visitor_id, cookie_hash, ip_hash, source, code_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    ).run(id, visitorId, cookieHash, ipHash, source, selectedCodeHash, now, now + 3 * 60_000)
    return { id, visitorId, source, cookieHash }
  })()
}

export function activateVoiceExperience(
  reservationId: string,
  roomId: string,
  expiresAt: number,
  now = Date.now(),
): void {
  const db = getDb()
  db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM voice_experience_sessions WHERE id = ?')
      .get(reservationId) as SessionRow | undefined
    if (!row || row.status !== 'reserved' || row.expires_at <= now) {
      throw new Error('voice_reservation_expired')
    }

    if (row.source === 'code' && row.code_hash) {
      const code = db
        .prepare('SELECT * FROM voice_experience_codes WHERE code_hash = ?')
        .get(row.code_hash) as CodeRow | undefined
      if (!codeIsUsable(code, now)) throw new Error('invalid_experience_code')
      db.prepare(
        `UPDATE voice_experience_codes
         SET used_count = used_count + 1, last_used_at = ? WHERE code_hash = ?`,
      ).run(now, row.code_hash)
    } else {
      const date = chinaDate(now)
      const browser = db
        .prepare('SELECT count FROM voice_experience_usage WHERE visitor_id = ? AND date = ?')
        .get(row.visitor_id, date) as UsageRow | undefined
      const ip = db
        .prepare('SELECT COALESCE(SUM(count), 0) AS count FROM voice_experience_usage WHERE ip_hash = ? AND date = ?')
        .get(row.ip_hash, date) as UsageRow
      if ((browser?.count ?? 0) >= VOICE_BROWSER_DAILY_LIMIT || ip.count >= VOICE_IP_DAILY_LIMIT) {
        throw new Error('voice_quota_exceeded')
      }
      db.prepare(
        `INSERT INTO voice_experience_usage (visitor_id, cookie_hash, ip_hash, date, count, last_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(visitor_id, date) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      ).run(row.visitor_id, row.cookie_hash, row.ip_hash, date, now)
    }

    db.prepare(
      `UPDATE voice_experience_sessions
       SET room_id = ?, status = 'active', expires_at = ? WHERE id = ?`,
    ).run(roomId, expiresAt, reservationId)
  })()
}

export function failVoiceReservation(reservationId: string, now = Date.now()): void {
  getDb()
    .prepare(
      `UPDATE voice_experience_sessions SET status = 'failed', stopped_at = ?
       WHERE id = ? AND status = 'reserved'`,
    )
    .run(now, reservationId)
}

export function stopVoiceExperience(reservationId: string, now = Date.now()): void {
  getDb()
    .prepare(
      `UPDATE voice_experience_sessions SET status = 'stopped', stopped_at = ?
       WHERE id = ? AND status IN ('reserved', 'active')`,
    )
    .run(now, reservationId)
}

export function generateVoiceExperienceCode(input?: {
  label?: string
  maxUses?: number
  validDays?: number
  now?: number
}): VoiceExperienceCode & { code: string } {
  const now = input?.now ?? Date.now()
  const raw = randomBytes(8).toString('hex').toUpperCase()
  const code = `CC-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`
  const maxUses = Math.max(1, Math.min(50, Math.floor(input?.maxUses ?? 1)))
  const validDays = Math.max(1, Math.min(30, Math.floor(input?.validDays ?? 7)))
  const label = input?.label?.trim().slice(0, 80) || null
  const expiresAt = now + validDays * 24 * 60 * 60_000
  const codeHint = `${code.slice(0, 7)}••••${code.slice(-4)}`
  getDb()
    .prepare(
      `INSERT INTO voice_experience_codes
       (code_hash, code_hint, label, max_uses, used_count, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(codeHash(code), codeHint, label, maxUses, expiresAt, now)
  return {
    code,
    codeHint,
    label,
    maxUses,
    usedCount: 0,
    expiresAt,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  }
}

export function listVoiceExperienceCodes(limit = 100): VoiceExperienceCode[] {
  return getDb()
    .prepare(
      `SELECT code_hint, label, max_uses, used_count, expires_at, created_at, last_used_at, revoked_at
       FROM voice_experience_codes ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 200)))
    .map((row) => {
      const item = row as {
        code_hint: string
        label: string | null
        max_uses: number
        used_count: number
        expires_at: number
        created_at: number
        last_used_at: number | null
        revoked_at: number | null
      }
      return {
        codeHint: item.code_hint,
        label: item.label,
        maxUses: item.max_uses,
        usedCount: item.used_count,
        expiresAt: item.expires_at,
        createdAt: item.created_at,
        lastUsedAt: item.last_used_at,
        revokedAt: item.revoked_at,
      }
    })
}

export function revokeVoiceExperienceCode(codeHint: string, now = Date.now()): boolean {
  const result = getDb()
    .prepare('UPDATE voice_experience_codes SET revoked_at = ? WHERE code_hint = ? AND revoked_at IS NULL')
    .run(now, codeHint)
  return result.changes > 0
}

export function resetVoiceVisitor(visitorId: string): boolean {
  const normalized = visitorId.trim().toUpperCase()
  if (!/^V-[A-F0-9]{10}$/.test(normalized)) return false
  const result = getDb()
    .prepare('DELETE FROM voice_experience_usage WHERE visitor_id = ? AND date = ?')
    .run(normalized, chinaDate())
  return result.changes > 0
}
