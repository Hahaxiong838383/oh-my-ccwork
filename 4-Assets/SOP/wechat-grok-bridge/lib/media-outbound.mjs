/**
 * Upload + send local files as WeChat iLink image/file/video.
 * Protocol from 1052-OS wechat.media.ts.
 */
import {
  createCipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  getWechatUploadUrl,
  sendWechatMessageItem,
  WECHAT_CDN_BASE_URL,
} from '../wechat-api.mjs'

const MAX_BYTES = 100 * 1024 * 1024
const MAX_OUTBOUND = 8
const CDN_RETRIES = 3
const FETCH_TIMEOUT_MS = 60_000

const ITEM_TYPE = { image: 2, file: 4, video: 5 }
const UPLOAD_MEDIA_TYPE = { image: 1, video: 2, file: 3 }

const MIME_BY_EXT = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.csv': 'text/csv',
}

function mimeFromName(fileName) {
  return (
    MIME_BY_EXT[path.extname(fileName).toLowerCase()] ||
    'application/octet-stream'
  )
}

function sanitizeFileName(value) {
  return (
    String(value || 'file')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .trim()
      .slice(0, 160) || 'file'
  )
}

function encryptAesEcb(plaintext, aesKeyHex) {
  const cipher = createCipheriv(
    'aes-128-ecb',
    Buffer.from(aesKeyHex, 'hex'),
    null,
  )
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function aesKeyForWechatMessage(aesKeyHex) {
  return Buffer.from(aesKeyHex, 'utf-8').toString('base64')
}

function aesEcbCiphertextSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

function buildCdnUploadUrl(response, filekey) {
  if (response.upload_full_url) return response.upload_full_url
  if (response.full_url) return response.full_url
  const uploadParam =
    response.upload_param ??
    response.encrypted_query_param ??
    response.encrypt_query_param
  if (!uploadParam) return null
  return `${WECHAT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(
    uploadParam,
  )}&filekey=${encodeURIComponent(filekey)}`
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function postCdnUpload(url, encrypted) {
  let lastError
  for (let attempt = 1; attempt <= CDN_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encrypted,
        signal: controller.signal,
      })
      const body = await response.text().catch(() => '')
      if (response.status >= 400 && response.status < 500) {
        throw new Error(
          `CDN client ${response.status}: ${response.headers.get('x-error-message') || body}`,
        )
      }
      if (response.status !== 200) {
        throw new Error(
          `CDN server ${response.status}: ${response.headers.get('x-error-message') || body}`,
        )
      }
      const headerParam =
        response.headers.get('x-encrypted-param') ??
        response.headers.get('x-encrypt-param') ??
        ''
      if (headerParam) return headerParam
      if (body.trim()) {
        try {
          const parsed = JSON.parse(body)
          const p =
            parsed.encrypted_query_param ?? parsed.encrypt_query_param ?? ''
          if (p) return p
        } catch {
          /* ignore */
        }
      }
      throw new Error('CDN upload missing x-encrypted-param')
    } catch (error) {
      lastError = error
      if (attempt < CDN_RETRIES) await sleep(250 * attempt)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new Error('CDN upload failed')
}

function uploadMediaType(mimeType) {
  if (mimeType.startsWith('image/')) return UPLOAD_MEDIA_TYPE.image
  if (mimeType.startsWith('video/')) return UPLOAD_MEDIA_TYPE.video
  return UPLOAD_MEDIA_TYPE.file
}

function buildUploadItem(upload) {
  const media = {
    encrypt_query_param: upload.encryptedQueryParam,
    aes_key: aesKeyForWechatMessage(upload.aeskeyHex),
    encrypt_type: 1,
  }
  if (upload.mimeType.startsWith('image/')) {
    return {
      type: ITEM_TYPE.image,
      image_item: { media, mid_size: upload.ciphertextSize },
    }
  }
  if (upload.mimeType.startsWith('video/')) {
    return {
      type: ITEM_TYPE.video,
      video_item: { media, video_size: upload.ciphertextSize },
    }
  }
  return {
    type: ITEM_TYPE.file,
    file_item: {
      media,
      file_name: upload.fileName,
      len: String(upload.plaintextSize),
    },
  }
}

/**
 * Extract local file paths from Grok reply for outbound media.
 * Patterns:
 *  - [[send-file:/abs/path]]
 *  - file:///abs/path
 *  - 本地路径: /abs/path
 */
export function extractOutboundMediaRefs(text) {
  const refs = []
  const s = String(text || '')
  for (const m of s.matchAll(/\[\[send-file:([^\]]+)\]\]/gi)) {
    refs.push(m[1].trim())
  }
  for (const m of s.matchAll(/file:\/\/([^\s)\]`]+)/gi)) {
    refs.push(decodeURIComponent(m[1]))
  }
  for (const line of s.split('\n')) {
    const m = line.match(/^\s*-?\s*(?:本地路径|Local Path)\s*[：:]\s*(.+?)\s*$/i)
    if (m?.[1]) refs.push(m[1].replace(/^`|`$/g, '').trim())
  }
  return [...new Set(refs)].slice(0, MAX_OUTBOUND)
}

/** Strip media markers from text for plain chat body */
export function stripMediaMarkers(text) {
  return String(text || '')
    .replace(/\[\[send-file:[^\]]+\]\]/gi, '')
    .replace(/file:\/\/[^\s)\]`]+/gi, '')
    .replace(/^\s*-?\s*(?:本地路径|Local Path)\s*[：:].*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function assertAllowedPath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath)
  const roots = (allowedRoots || []).map((r) => path.resolve(r))
  const ok = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  )
  if (!ok) {
    throw new Error(`outbound path not allowed: ${resolved}`)
  }
  return resolved
}

export async function uploadAndSendFile({
  baseUrl,
  token,
  to,
  filePath,
  contextToken,
  allowedRoots,
  log = () => {},
}) {
  const resolved = assertAllowedPath(filePath, allowedRoots)
  const st = await fs.stat(resolved)
  if (!st.isFile()) throw new Error(`not a file: ${resolved}`)
  if (st.size > MAX_BYTES) throw new Error(`file too large: ${st.size}`)

  const bytes = await fs.readFile(resolved)
  const fileName = sanitizeFileName(path.basename(resolved))
  const mimeType = mimeFromName(fileName)
  const aeskeyHex = randomBytes(16).toString('hex')
  const filekey = randomBytes(16).toString('hex')
  const encrypted = encryptAesEcb(bytes, aeskeyHex)
  const rawMd5 = createHash('md5').update(bytes).digest('hex')

  const uploadUrl = await getWechatUploadUrl({
    baseUrl,
    token,
    filekey,
    mediaType: uploadMediaType(mimeType),
    to,
    rawsize: bytes.byteLength,
    rawfilemd5: rawMd5,
    filesize: aesEcbCiphertextSize(bytes.byteLength),
    aeskey: aeskeyHex,
  })

  const isError =
    (uploadUrl.ret !== undefined && uploadUrl.ret !== 0) ||
    (uploadUrl.errcode !== undefined && uploadUrl.errcode !== 0)
  if (isError) {
    throw new Error(
      `getuploadurl failed: ${uploadUrl.errmsg ?? uploadUrl.errcode ?? uploadUrl.ret}`,
    )
  }

  const cdnUrl = buildCdnUploadUrl(uploadUrl, filekey)
  if (!cdnUrl) throw new Error('getuploadurl missing upload URL')

  const encryptedQueryParam = await postCdnUpload(cdnUrl, encrypted)
  const item = buildUploadItem({
    aeskeyHex,
    encryptedQueryParam,
    ciphertextSize: encrypted.byteLength,
    plaintextSize: bytes.byteLength,
    mimeType,
    fileName,
  })

  await sendWechatMessageItem({
    baseUrl,
    token,
    to,
    item,
    contextToken,
  })
  log('outbound media sent', mimeType, fileName, `bytes=${bytes.byteLength}`)
  return { fileName, mimeType, bytes: bytes.byteLength }
}

/**
 * Parse reply → send text chunks (caller) + media files.
 * Returns { text, mediaSent, warnings }
 */
export async function processOutboundReply({
  baseUrl,
  token,
  to,
  text,
  contextToken,
  allowedRoots,
  sendTextFn,
  log = () => {},
}) {
  const refs = extractOutboundMediaRefs(text)
  const cleaned = stripMediaMarkers(text)
  const warnings = []
  let mediaSent = 0

  if (cleaned) {
    await sendTextFn(cleaned)
  }

  for (const ref of refs) {
    try {
      await uploadAndSendFile({
        baseUrl,
        token,
        to,
        filePath: ref.replace(/^file:\/\//, ''),
        contextToken,
        allowedRoots,
        log,
      })
      mediaSent += 1
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 160)
      warnings.push(msg)
      log('outbound media fail', msg)
    }
  }

  if (warnings.length) {
    await sendTextFn(
      `【部分文件发送失败】\n${warnings.map((w) => `· ${w}`).join('\n')}`,
    ).catch(() => {})
  }

  return { text: cleaned, mediaSent, warnings }
}
