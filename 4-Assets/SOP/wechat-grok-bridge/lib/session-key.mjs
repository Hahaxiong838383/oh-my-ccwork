/**
 * Sticky session keys for WeChat channel (Hermes-style, parallel to feishu).
 *
 * DM:    wechat:dm:{peerId}:{cwdHash}
 * Group: wechat:group:{roomId}:{peerId}:{cwdHash}  (per-user default)
 *        wechat:group:{roomId}:{cwdHash}           (shared)
 */
import { createHash } from 'node:crypto'
import path from 'node:path'

export function cwdHash(cwd) {
  const resolved = path.resolve(String(cwd || ''))
  return createHash('sha256').update(resolved).digest('hex').slice(0, 10)
}

/**
 * @param {{
 *   chatKind?: 'dm'|'group',
 *   peerId?: string,
 *   roomId?: string,
 *   cwd?: string,
 *   groupSessionsPerUser?: boolean,
 * }} p
 */
export function buildSessionKey(p) {
  const ch = cwdHash(p.cwd)
  const peer = String(p.peerId || 'unknown')
  const kind = p.chatKind === 'group' ? 'group' : 'dm'

  if (kind === 'dm') {
    return `wechat:dm:${peer}:${ch}`
  }

  const room = String(p.roomId || 'group')
  const perUser = p.groupSessionsPerUser !== false
  if (perUser) {
    return `wechat:group:${room}:${peer}:${ch}`
  }
  return `wechat:group:${room}:${ch}`
}
