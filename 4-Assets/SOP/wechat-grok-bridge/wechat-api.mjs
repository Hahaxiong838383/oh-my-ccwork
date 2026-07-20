/**
 * WeChat iLink Bot API helpers (from 1052-OS / wechat-qr-login-module upstream).
 * getupdates long-poll + sendmessage text/media + getuploadurl.
 */
import crypto from 'node:crypto'

const CHANNEL_VERSION = '2.1.8'
const ILINK_APP_ID = 'bot'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000

export const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf-8').toString('base64')
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION }
}

function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(CHANNEL_VERSION)),
  }
}

function postHeaders(body, token) {
  return {
    ...commonHeaders(),
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
  }
}

async function fetchText(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`微信接口请求失败 ${response.status}: ${text.slice(0, 200)}`)
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function postJson(baseUrl, endpoint, payload, token, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl))
  const body = JSON.stringify(payload)
  const text = await fetchText(
    url.toString(),
    { method: 'POST', headers: postHeaders(body, token), body },
    timeoutMs,
  )
  return JSON.parse(text)
}

function assertWechatApiOk(response, label) {
  const failed =
    (response.ret !== undefined && response.ret !== 0) ||
    (response.errcode !== undefined && response.errcode !== 0)
  if (failed) {
    throw new Error(
      `${label} failed: ${response.errmsg ?? response.errcode ?? response.ret}`,
    )
  }
}

export async function getWechatUpdates({
  baseUrl,
  token,
  getUpdatesBuf = '',
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
}) {
  return postJson(
    baseUrl,
    'ilink/bot/getupdates',
    {
      get_updates_buf: getUpdatesBuf ?? '',
      base_info: baseInfo(),
    },
    token,
    timeoutMs,
  )
}

function clientId(prefix = 'linux-lan-wechat') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

export async function sendWechatText({
  baseUrl,
  token,
  to,
  text,
  contextToken,
}) {
  const id = clientId()
  const response = await postJson(
    baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: id,
        message_type: 2,
        message_state: 2,
        item_list: text ? [{ type: 1, text_item: { text } }] : undefined,
        context_token: contextToken,
      },
      base_info: baseInfo(),
    },
    token,
  )
  assertWechatApiOk(response, 'Wechat sendmessage')
  return id
}

/** Send arbitrary item_list entry (image/file/video item) */
export async function sendWechatMessageItem({
  baseUrl,
  token,
  to,
  item,
  contextToken,
}) {
  const id = clientId('linux-lan-wechat-media')
  const response = await postJson(
    baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: id,
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: contextToken,
      },
      base_info: baseInfo(),
    },
    token,
  )
  assertWechatApiOk(response, 'Wechat sendmessage media')
  return id
}

/**
 * Request CDN upload URL for outbound media.
 * mediaType: 1=image 2=video 3=file
 */
export async function getWechatUploadUrl({
  baseUrl,
  token,
  filekey,
  mediaType,
  to,
  rawsize,
  rawfilemd5,
  filesize,
  aeskey,
}) {
  return postJson(
    baseUrl,
    'ilink/bot/getuploadurl',
    {
      filekey,
      media_type: mediaType,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey,
      base_info: baseInfo(),
    },
    token,
  )
}

/** Extract plain text from inbound WechatMessage (legacy helper) */
export function extractWechatText(message) {
  const parts = []
  const walk = (item) => {
    if (!item) return
    if (item.text_item?.text) parts.push(String(item.text_item.text))
    if (item.voice_item?.text) parts.push(String(item.voice_item.text))
    if (item.ref_msg?.message_item) {
      for (const sub of item.ref_msg.message_item) walk(sub)
    }
  }
  for (const it of message?.item_list || []) walk(it)
  return parts.join('\n').trim()
}
