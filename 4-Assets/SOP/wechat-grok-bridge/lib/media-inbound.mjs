/**
 * Download WeChat iLink inbound image/voice/file/video via CDN + AES-128-ECB.
 * Ported from 1052-OS wechat.media.ts (no host config deps).
 */
import {
  createDecipheriv,
  createHash,
  randomUUID,
} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MAX_BYTES = 100 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000

const ITEM_TYPE = { image: 2, voice: 3, file: 4, video: 5 }

const MIME_BY_EXT = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.silk': 'audio/silk',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
}

const EXT_BY_MIME = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
)

function sanitizeFileName(value) {
  return (
    String(value || 'media')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'media'
  )
}

function dayStamp(d = new Date()) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function mimeFromName(fileName, fallback = 'application/octet-stream') {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] || fallback
}

function extensionFromMime(mimeType, fallback = '.bin') {
  const n = String(mimeType || '')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  return EXT_BY_MIME[n] || fallback
}

function parseAesKey(value) {
  const cleaned = String(value || '').trim()
  if (/^[0-9a-f]{32}$/i.test(cleaned)) return Buffer.from(cleaned, 'hex')
  const decoded = Buffer.from(cleaned, 'base64')
  if (decoded.length === 16) return decoded
  const asText = decoded.toString('ascii')
  if (/^[0-9a-f]{32}$/i.test(asText)) return Buffer.from(asText, 'hex')
  throw new Error('Wechat media AES key invalid')
}

function decryptAesEcb(ciphertext, aesKey) {
  const decipher = createDecipheriv('aes-128-ecb', parseAesKey(aesKey), null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function buildCdnDownloadUrl(media) {
  if (media?.full_url) return media.full_url
  if (!media?.encrypt_query_param) return null
  return `${WECHAT_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(
    media.encrypt_query_param,
  )}`
}

async function fetchBuffer(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      const t = await response.text().catch(() => '')
      throw new Error(`CDN ${response.status}: ${t.slice(0, 120)}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_BYTES) {
      throw new Error(`media too large ${buffer.byteLength}`)
    }
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

function itemKind(item) {
  if (item?.type === ITEM_TYPE.image || item?.image_item) return 'image'
  if (item?.type === ITEM_TYPE.voice || item?.voice_item) return 'voice'
  if (item?.type === ITEM_TYPE.file || item?.file_item) return 'file'
  if (item?.type === ITEM_TYPE.video || item?.video_item) return 'video'
  return null
}

function itemMedia(item, kind) {
  if (kind === 'image')
    return item.image_item?.media ?? item.image_item?.thumb_media
  if (kind === 'voice') return item.voice_item?.media
  if (kind === 'file') return item.file_item?.media
  if (kind === 'video') return item.video_item?.media
  return undefined
}

function itemAesKey(item, kind, media) {
  if (kind === 'image' && item.image_item?.aeskey) return item.image_item.aeskey
  return media?.aes_key
}

function guessName(kind, item) {
  if (kind === 'file' && item.file_item?.file_name) return item.file_item.file_name
  if (kind === 'image') return 'wechat-image.jpg'
  if (kind === 'voice') return 'wechat-voice.silk'
  if (kind === 'video') return 'wechat-video.mp4'
  return 'wechat-media.bin'
}

/**
 * Download one message item to outDir.
 * @returns {Promise<null|{path:string,type:string,fileName:string,bytes:number,mimeType:string,text?:string}>}
 */
export async function downloadWechatMediaItem(item, outDir) {
  const kind = itemKind(item)
  if (!kind) return null

  const media = itemMedia(item, kind)
  const originalFileName = sanitizeFileName(guessName(kind, item))
  const mimeType =
    kind === 'image'
      ? mimeFromName(originalFileName, 'image/jpeg')
      : kind === 'voice'
        ? mimeFromName(originalFileName, 'audio/silk')
        : kind === 'video'
          ? mimeFromName(originalFileName, 'video/mp4')
          : mimeFromName(originalFileName)

  let buffer = null
  if (media) {
    const url = buildCdnDownloadUrl(media)
    if (!url) return null
    const raw = await fetchBuffer(url)
    const aes = itemAesKey(item, kind, media)
    buffer = aes ? decryptAesEcb(raw, aes) : raw
  } else if (kind === 'image' && item.image_item?.url?.trim()) {
    buffer = await fetchBuffer(item.image_item.url.trim())
  }
  if (!buffer) return null

  await fs.mkdir(outDir, { recursive: true })
  const ext =
    path.extname(originalFileName) || extensionFromMime(mimeType)
  const fileName = `${randomUUID().slice(0, 8)}-${sanitizeFileName(
    path.basename(originalFileName, path.extname(originalFileName)),
  )}${ext}`
  const dest = path.join(outDir, fileName)
  await fs.writeFile(dest, buffer)
  return {
    path: dest,
    type: kind,
    fileName: originalFileName,
    bytes: buffer.byteLength,
    mimeType,
    text: kind === 'voice' ? item.voice_item?.text : undefined,
  }
}

/**
 * Download all media in a WeChat message into cwd/.inbound-media/<day>/.
 */
export async function downloadInboundMedia({ message, cwd, log = () => {} }) {
  const outDir = path.join(cwd, '.inbound-media', dayStamp())
  const files = []
  const errors = []

  const walkItems = async (items) => {
    for (const item of items || []) {
      if (item?.ref_msg?.message_item?.length) {
        await walkItems(item.ref_msg.message_item)
      }
      const kind = itemKind(item)
      if (!kind) continue
      try {
        const saved = await downloadWechatMediaItem(item, outDir)
        if (saved) {
          files.push(saved)
          log('media saved', saved.type, saved.path, `bytes=${saved.bytes}`)
        } else {
          errors.push(`${kind}: missing CDN params`)
        }
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 160)
        errors.push(`${kind}: ${msg}`)
        log('media download fail', kind, msg)
      }
    }
  }

  await walkItems(message?.item_list)
  return { files, errors, dir: outDir }
}

/**
 * Build prompt injection for downloaded media (Grok Read-friendly).
 */
export function formatMediaPrompt(result, userText = '') {
  const lines = []
  const text = String(userText || '').trim()
  if (text) lines.push(text)

  if (result?.files?.length) {
    lines.push('')
    lines.push(
      '【用户通过微信发送的附件（已下载到本地，可用 Read/Bash 打开）】',
    )
    for (const f of result.files) {
      const kindLabel =
        f.type === 'image'
          ? '图片'
          : f.type === 'voice'
            ? '语音'
            : f.type === 'video'
              ? '视频'
              : '文件'
      const name = f.fileName || path.basename(f.path)
      lines.push(`- ${kindLabel}: \`${f.path}\` (${f.bytes} bytes, ${name})`)
      if (f.text) lines.push(`  转写：${String(f.text).slice(0, 500)}`)
    }
    lines.push(
      '请根据附件内容完成用户任务；若用户未写文字，请先描述附件要点再行动。',
    )
    lines.push(
      '若需回传图片/文件给用户：在回复中写一行 `[[send-file:/绝对路径]]`（桥接会上传发送）。',
    )
  }

  if (result?.errors?.length) {
    lines.push('')
    lines.push('【部分附件下载失败】')
    for (const e of result.errors) lines.push(`- ${e}`)
  }

  return lines.join('\n').trim()
}

/** hash helper for tests/dedupe */
export function mediaFingerprint(filePath) {
  return createHash('sha256').update(String(filePath)).digest('hex').slice(0, 12)
}
