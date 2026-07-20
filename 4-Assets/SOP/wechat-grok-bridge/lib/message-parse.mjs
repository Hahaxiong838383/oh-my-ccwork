/**
 * WeChat inbound message parsing: text, force prefix, group heuristics.
 */

/** Extract plain text (+ voice transcription) from WeChat message */
export function extractWechatText(message) {
  const parts = []
  const walk = (item) => {
    if (!item) return
    if (item.text_item?.text) parts.push(String(item.text_item.text))
    if (item.voice_item?.text) {
      parts.push(`语音转写：${String(item.voice_item.text)}`)
    }
    if (item.ref_msg?.message_item) {
      for (const sub of item.ref_msg.message_item) walk(sub)
    }
  }
  for (const it of message?.item_list || []) walk(it)
  return parts.join('\n').trim()
}

/** True if message has any media item (image/voice/file/video) */
export function hasMediaItems(message) {
  const walk = (item) => {
    if (!item) return false
    if (
      item.type === 2 ||
      item.type === 3 ||
      item.type === 4 ||
      item.type === 5 ||
      item.image_item ||
      item.voice_item ||
      item.file_item ||
      item.video_item
    ) {
      return true
    }
    return (item.ref_msg?.message_item || []).some(walk)
  }
  return (message?.item_list || []).some(walk)
}

/**
 * Detect group-like chat.
 * iLink DM: typically only from_user_id.
 * Best-effort: room_id / chatroom_id / group_id / session_type fields if present.
 */
export function detectChatKind(message) {
  const roomId =
    message?.room_id ||
    message?.chatroom_id ||
    message?.group_id ||
    message?.chat_id ||
    message?.to_room_id ||
    ''
  if (roomId) {
    return { kind: 'group', roomId: String(roomId) }
  }
  // Some payloads use session_type / chat_type numbers (unknown enum → treat group if >1)
  const st = message?.session_type ?? message?.chat_type
  if (st !== undefined && st !== null && String(st) !== '0' && String(st) !== '1' && String(st) !== 'dm') {
    if (String(st).toLowerCase().includes('group') || Number(st) > 1) {
      return { kind: 'group', roomId: String(message?.to_user_id || 'group') }
    }
  }
  return { kind: 'dm', roomId: '' }
}

/**
 * Strip force prefix and detect if mentioned/forced.
 * Prefixes: grok: /grok @bot-name
 * @returns {{ forced: boolean, body: string, mentioned: boolean }}
 */
export function stripForcePrefix(text, { botName = '', botAccountId = '' } = {}) {
  let body = String(text || '').trim()
  let forced = false
  let mentioned = false

  const prefixRe = /^(?:grok:|\/grok(?:\s+|$)|@grok(?:\s+|$))/i
  if (prefixRe.test(body)) {
    forced = true
    mentioned = true
    body = body.replace(prefixRe, '').trim()
  }

  if (botName) {
    const re = new RegExp(
      `^@?${escapeReg(botName)}(?:\\s+|[:：]|$)`,
      'i',
    )
    if (re.test(body)) {
      mentioned = true
      body = body.replace(re, '').trim()
    }
    if (body.includes(`@${botName}`) || body.includes(botName)) {
      mentioned = true
    }
  }

  if (botAccountId && body.includes(botAccountId)) {
    mentioned = true
  }

  // bare @bot
  if (/@bot\b/i.test(body)) {
    mentioned = true
    body = body.replace(/@bot\b/gi, '').trim()
  }

  return { forced, body, mentioned }
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether to process this inbound message for group policy.
 * DM: always (subject to allowlist).
 * Group: need force prefix OR mention OR media-with-prefix env.
 */
export function shouldProcessMessage({
  chatKind,
  forced,
  mentioned,
  hasMedia,
  requireGroupPrefix,
}) {
  if (chatKind === 'dm') return true
  if (!requireGroupPrefix) return true
  if (forced || mentioned) return true
  // media-only in group still needs mention/force when require prefix
  if (hasMedia && (forced || mentioned)) return true
  return false
}
