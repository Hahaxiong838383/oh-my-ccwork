import 'server-only'
import { getDb } from '@/lib/analytics/db'

export interface DemoRoutingStep {
  engine: string
  stage: string
  duration_ms: number
  output_md: string
  [key: string]: unknown
}

export interface ClassicDemo {
  id: string
  category: string
  question: string
  routing: DemoRoutingStep[]
  featured: boolean
  quality_score: number
  created_at: number
  updated_at: number
}

interface ClassicDemoRow {
  id: string
  category: string
  question: string
  routing: string
  featured: number
  quality_score: number
  created_at: number
  updated_at: number
}

interface SaveDemoInput {
  id: string
  category: string
  question: string
  routing: DemoRoutingStep[]
  featured?: boolean
  quality_score?: number
}

function parseRouting(raw: string): DemoRoutingStep[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed as DemoRoutingStep[]
    }
    return []
  } catch {
    return []
  }
}

function normalizeRow(row: ClassicDemoRow): ClassicDemo {
  return {
    id: row.id,
    category: row.category,
    question: row.question,
    routing: parseRouting(row.routing),
    featured: row.featured === 1,
    quality_score: row.quality_score,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function getClassicDemoById(id: string): ClassicDemo | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, category, question, routing, featured, quality_score, created_at, updated_at
       FROM classic_demos
       WHERE id = ?`,
    )
    .get(id) as ClassicDemoRow | undefined

  return row ? normalizeRow(row) : null
}

export function listClassicDemos(limit = 100): ClassicDemo[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, category, question, routing, featured, quality_score, created_at, updated_at
       FROM classic_demos
       ORDER BY featured DESC, quality_score DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ClassicDemoRow[]

  return rows.map(normalizeRow)
}

export function saveClassicDemo(input: SaveDemoInput): ClassicDemo {
  const db = getDb()
  const now = Date.now()
  const featured = input.featured ? 1 : 0
  const qualityScore = Number.isFinite(input.quality_score) ? Number(input.quality_score) : 50

  db.prepare(
    `INSERT INTO classic_demos
      (id, category, question, routing, featured, quality_score, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id)
     DO UPDATE SET
       category = excluded.category,
       question = excluded.question,
       routing = excluded.routing,
       featured = excluded.featured,
       quality_score = excluded.quality_score,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.category,
    input.question,
    JSON.stringify(input.routing),
    featured,
    qualityScore,
    now,
    now,
  )

  const saved = getClassicDemoById(input.id)
  if (!saved) {
    throw new Error('save_demo_failed')
  }
  return saved
}

export function deleteClassicDemo(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM classic_demos WHERE id = ?').run(id)
  return result.changes > 0
}
