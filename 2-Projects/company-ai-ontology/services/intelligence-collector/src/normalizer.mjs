import crypto from 'node:crypto'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function decodeXml(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function tagValue(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
    if (match) return decodeXml(match[1])
  }
  return ''
}

function atomLink(block) {
  const match = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)
  return match ? decodeXml(match[1]) : ''
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    return parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function normalizedTimestamp(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function normalizedItem(sourceKey, input, fetchedAt) {
  const title = String(input.title || '').trim().slice(0, 500)
  const url = safeHttpsUrl(input.url)
  if (!title || !url) return null
  const sourceItemId = String(input.sourceItemId || url).trim().slice(0, 500)
  const summary = String(input.summary || '').trim().slice(0, 4000)
  const publishedAt = normalizedTimestamp(input.publishedAt)
  const contentHash = sha256(JSON.stringify({ sourceKey, sourceItemId, title, url, summary, publishedAt }))
  return {
    itemKey: sha256(`${sourceKey}\n${sourceItemId}\n${url}`),
    sourceKey,
    sourceItemId,
    title,
    url,
    summary,
    publishedAt,
    fetchedAt,
    contentHash,
  }
}

function contentHash(item) {
  return sha256(JSON.stringify({
    sourceKey: item.sourceKey,
    sourceItemId: item.sourceItemId,
    title: item.title,
    url: item.url,
    summary: item.summary,
    publishedAt: item.publishedAt,
  }))
}

export function applyItemRetention(items, storageLevel) {
  if (!['reference_only', 'metadata_only', 'summary_metadata', 'structured_data', 'full_text'].includes(storageLevel)) {
    throw new Error(`unsupported storage level ${storageLevel}`)
  }
  return items.map((item) => {
    const projected = structuredClone(item)
    if (storageLevel === 'reference_only' || storageLevel === 'metadata_only') projected.summary = ''
    projected.contentHash = contentHash(projected)
    return projected
  })
}

export function parseFeed(sourceKey, body, fetchedAt) {
  const blocks = [...String(body).matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2])
  return blocks.map((block) => normalizedItem(sourceKey, {
    sourceItemId: tagValue(block, ['guid', 'id']),
    title: tagValue(block, ['title']),
    url: tagValue(block, ['link']) || atomLink(block),
    summary: tagValue(block, ['description', 'summary', 'content', 'content:encoded']),
    publishedAt: tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']),
  }, fetchedAt)).filter(Boolean)
}

function jsonItems(payload) {
  if (Array.isArray(payload)) return payload
  for (const value of [payload?.items, payload?.results, payload?.data, payload?.response?.docs]) {
    if (Array.isArray(value)) return value
  }
  return []
}

export function parseJsonItems(sourceKey, body, fetchedAt) {
  const payload = JSON.parse(body)
  return jsonItems(payload).map((item) => normalizedItem(sourceKey, {
    sourceItemId: item?.id || item?.key || item?.guid || item?.doi || item?.url || item?.html_url,
    title: item?.title || item?.name || item?.headline || item?.display_name,
    url: item?.url || item?.html_url || item?.link || item?.doi_url,
    summary: item?.summary || item?.description || item?.abstract || item?.body,
    publishedAt: item?.publishedAt || item?.published_at || item?.publication_date || item?.updated_at || item?.date,
  }, fetchedAt)).filter(Boolean)
}

export function deduplicateItems(items) {
  const itemKeys = new Set()
  const urls = new Set()
  const contentHashes = new Set()
  const output = []
  let duplicateCount = 0
  for (const item of items) {
    if (itemKeys.has(item.itemKey) || urls.has(item.url) || contentHashes.has(item.contentHash)) {
      duplicateCount += 1
      continue
    }
    itemKeys.add(item.itemKey)
    urls.add(item.url)
    contentHashes.add(item.contentHash)
    output.push(item)
  }
  return { items: output, duplicateCount }
}

export function hashBytes(bytes) {
  return sha256(bytes)
}
