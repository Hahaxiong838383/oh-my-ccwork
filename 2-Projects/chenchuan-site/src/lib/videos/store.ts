import 'server-only'
import { getDb } from '@/lib/analytics/db'

// 视频库持久化（SQLite managed_videos 表）。
// /admin/videos 编辑；公开 /videos + 首页 VideoSection 经 getVideos() 读 published=1。
// 仿 src/lib/chat/demos.ts 的模式（getDb + 预编译语句 + upsert）。

export interface ManagedVideo {
  id: string
  title: string
  description: string
  url: string
  thumbnail: string
  duration: string
  tags: string[]
  projectSlug: string | null
  published: boolean
  sort: number
  created_at: number
  updated_at: number
}

interface ManagedVideoRow {
  id: string
  title: string
  description: string | null
  url: string
  thumbnail: string | null
  duration: string | null
  tags: string | null
  project_slug: string | null
  published: number
  sort: number
  created_at: number
  updated_at: number
}

export interface SaveVideoInput {
  id: string
  title: string
  description?: string
  url: string
  thumbnail?: string
  duration?: string
  tags?: string[]
  projectSlug?: string | null
  published?: boolean
  sort?: number
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function normalizeRow(row: ManagedVideoRow): ManagedVideo {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    url: row.url,
    thumbnail: row.thumbnail ?? '',
    duration: row.duration ?? '',
    tags: parseTags(row.tags),
    projectSlug: row.project_slug,
    published: row.published === 1,
    sort: row.sort,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const COLS =
  'id, title, description, url, thumbnail, duration, tags, project_slug, published, sort, created_at, updated_at'

export function getManagedVideoById(id: string): ManagedVideo | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT ${COLS} FROM managed_videos WHERE id = ?`)
    .get(id) as ManagedVideoRow | undefined
  return row ? normalizeRow(row) : null
}

// admin 用：全部视频（含已下架），按 sort 升序、更新时间倒序
export function listManagedVideos(limit = 500): ManagedVideo[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM managed_videos
       ORDER BY sort ASC, updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ManagedVideoRow[]
  return rows.map(normalizeRow)
}

// 前台用：仅上架，按 sort 升序、更新时间倒序
export function listPublishedVideos(limit = 500): ManagedVideo[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM managed_videos
       WHERE published = 1
       ORDER BY sort ASC, updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ManagedVideoRow[]
  return rows.map(normalizeRow)
}

export function saveManagedVideo(input: SaveVideoInput): ManagedVideo {
  const db = getDb()
  const now = Date.now()
  const existing = getManagedVideoById(input.id)
  const createdAt = existing?.created_at ?? now

  db.prepare(
    `INSERT INTO managed_videos
      (id, title, description, url, thumbnail, duration, tags, project_slug, published, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       url = excluded.url,
       thumbnail = excluded.thumbnail,
       duration = excluded.duration,
       tags = excluded.tags,
       project_slug = excluded.project_slug,
       published = excluded.published,
       sort = excluded.sort,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.title,
    input.description ?? '',
    input.url,
    input.thumbnail ?? '',
    input.duration ?? '',
    JSON.stringify(input.tags ?? []),
    input.projectSlug ?? null,
    input.published === false ? 0 : 1,
    Number.isFinite(input.sort) ? Number(input.sort) : 0,
    createdAt,
    now,
  )

  const saved = getManagedVideoById(input.id)
  if (!saved) throw new Error('save_video_failed')
  return saved
}

export function deleteManagedVideo(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM managed_videos WHERE id = ?').run(id)
  return result.changes > 0
}

// 表是否为空（getVideos 判断是否走 DB 还是本地兜底）
export function countManagedVideos(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) AS n FROM managed_videos').get() as { n: number }
  return row.n
}
