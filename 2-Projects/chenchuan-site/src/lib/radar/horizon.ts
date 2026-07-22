import type {
  HorizonDigestItem,
  HorizonDigestReference,
  HorizonDigestReport,
  RadarCategory,
} from './types'

const MAX_ITEMS = 20
const MAX_REFERENCES = 4
const MAX_TAGS = 8
const CATEGORIES = new Set<RadarCategory>([
  'ai-models',
  'ai-products',
  'industry',
  'paper',
  'tip',
])

type RecordValue = Record<string, unknown>

export type SanitizedHorizonPayload = {
  publish: boolean
  report: HorizonDigestReport
}

function asRecord(value: unknown): RecordValue {
  return value && typeof value === 'object' ? (value as RecordValue) : {}
}

function clampStr(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function safeUrl(value: unknown): string {
  const raw = clampStr(value, 2048)
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function safeDate(value: unknown): string {
  const raw = clampStr(value, 10) || ''
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
}

function safeIso(value: unknown): string | undefined {
  const raw = clampStr(value, 40)
  if (!raw || Number.isNaN(Date.parse(raw))) return undefined
  return new Date(raw).toISOString()
}

function safeNumber(value: unknown, fallback = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(max, value))
    : fallback
}

function safeCategory(value: unknown): RadarCategory | null {
  return typeof value === 'string' && CATEGORIES.has(value as RadarCategory)
    ? (value as RadarCategory)
    : null
}

function sanitizeReferences(value: unknown): HorizonDigestReference[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .slice(0, MAX_REFERENCES * 2)
    .map((entry) => {
      const raw = asRecord(entry)
      return { title: clampStr(raw.title, 160), url: safeUrl(raw.url) }
    })
    .filter((entry) => {
      if (!entry.url || seen.has(entry.url)) return false
      seen.add(entry.url)
      return true
    })
    .slice(0, MAX_REFERENCES)
}

function sanitizeItem(value: unknown, index: number): HorizonDigestItem | null {
  const raw = asRecord(value)
  const title = clampStr(raw.title, 300)
  const url = safeUrl(raw.url)
  const summary = clampStr(raw.summary, 1200)
  if (!title || !url || !summary) return null

  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .map((tag) => clampStr(tag, 40))
        .filter((tag): tag is string => Boolean(tag))
        .slice(0, MAX_TAGS)
    : []

  return {
    id: clampStr(raw.id, 180) || `horizon-${index + 1}`,
    title,
    titleEn: clampStr(raw.titleEn, 300),
    url,
    source: clampStr(raw.source, 120) || 'Horizon source',
    sourceType: clampStr(raw.sourceType, 40),
    publishedAt: safeIso(raw.publishedAt) || null,
    score: safeNumber(raw.score, 0, 10),
    summary,
    whyItMatters: clampStr(raw.whyItMatters, 1200),
    keyDetails: clampStr(raw.keyDetails, 1200),
    background: clampStr(raw.background, 1600),
    communityDiscussion: clampStr(raw.communityDiscussion, 1600),
    tags,
    category: safeCategory(raw.category),
    references: sanitizeReferences(raw.references),
  }
}

export function sanitizeHorizonDigestPayload(
  value: unknown,
  receivedAt = new Date(),
): SanitizedHorizonPayload | null {
  const raw = asRecord(value)
  if (raw.type !== 'horizon') return null

  const date = safeDate(raw.date)
  if (!date || !Array.isArray(raw.items)) return null

  const items = raw.items
    .slice(0, MAX_ITEMS)
    .map(sanitizeItem)
    .filter((item): item is HorizonDigestItem => Boolean(item))
  if (items.length === 0) return null

  return {
    publish: raw.publish === true,
    report: {
      type: 'horizon',
      date,
      generatedAt: receivedAt.toISOString(),
      sourceGeneratedAt: safeIso(raw.generatedAt),
      summary: clampStr(raw.summary, 800),
      totalFetched: Math.round(safeNumber(raw.totalFetched, items.length, 10000)),
      sourceCount: Math.round(safeNumber(raw.sourceCount, 0, 1000)),
      realtimeDuplicateCount: Math.round(safeNumber(raw.realtimeDuplicateCount, 0, 10000)),
      relevanceFilteredCount: Math.round(safeNumber(raw.relevanceFilteredCount, 0, 10000)),
      runId: clampStr(raw.runId, 160),
      horizonCommit: clampStr(raw.horizonCommit, 64),
      items,
    },
  }
}

export function isHorizonDigestReport(value: unknown): value is HorizonDigestReport {
  const raw = asRecord(value)
  return (
    raw.type === 'horizon' &&
    Boolean(safeDate(raw.date)) &&
    typeof raw.generatedAt === 'string' &&
    Array.isArray(raw.items) &&
    raw.items.length > 0
  )
}
