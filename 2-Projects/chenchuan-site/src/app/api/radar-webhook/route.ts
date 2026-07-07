// radar agent 推送入口（theory-radar 深度报告 + github-radar 风向标共用）
// 用法（mini 上的 agent 跑完后调用）：
//   curl -X POST https://my.chenchuan.cc/api/radar-webhook \
//     -H "Authorization: Bearer $RADAR_WEBHOOK_TOKEN" \
//     -H "Content-Type: application/json" \
//     -d @report.json
// body.type='github' → GithubRadarReport 落 data/radar-github/；否则按 TheoryReport 落 data/radar/
// 报告结构见 src/lib/radar/types.ts

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { revalidatePath } from 'next/cache'

export const runtime = 'nodejs'

const TOKEN = process.env.RADAR_WEBHOOK_TOKEN
const DIR = process.env.RADAR_DATA_DIR || path.join(process.cwd(), 'data', 'radar')
const GITHUB_DIR =
  process.env.RADAR_GITHUB_DATA_DIR || path.join(process.cwd(), 'data', 'radar-github')
const MAX_BODY_BYTES = 512 * 1024 // 512KB 上限，防失控 agent/恶意 payload 撑爆磁盘
const MAX_PAPERS = 50
const MAX_CATEGORIES = 10
const MAX_REPOS_PER_CATEGORY = 10
const MAX_JUDGMENTS = 12

// 只接受 http(s) 链接（防 javascript:/data: 等注入到 href → 存储型 XSS）
function safeUrl(u: unknown): string {
  if (typeof u !== 'string') return ''
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:' ? u : ''
  } catch {
    return ''
  }
}

function clampStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined
}

export async function POST(req: NextRequest) {
  if (!TOKEN) {
    return NextResponse.json({ ok: false, error: 'webhook 未配置 token' }, { status: 503 })
  }

  const auth = req.headers.get('authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (token !== TOKEN) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // body 大小上限（防 OOM/磁盘 DoS）
  const len = Number(req.headers.get('content-length') || '0')
  if (len > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload 过大' }, { status: 413 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 })
  }

  // github-radar 分支（body.type='github'）：独立目录，绝不混入 theory 报告目录
  if ((body as { type?: unknown }).type === 'github') {
    return handleGithubReport(body)
  }

  const report = body as { date?: unknown; papers?: unknown }
  if (!report || typeof report.date !== 'string' || !Array.isArray(report.papers)) {
    return NextResponse.json(
      { ok: false, error: '缺少 date 或 papers 字段' },
      { status: 400 },
    )
  }

  // 仅允许 YYYY-MM-DD 形态，防路径穿越
  const safeDate = report.date.replace(/[^0-9-]/g, '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
    return NextResponse.json({ ok: false, error: 'date 格式应为 YYYY-MM-DD' }, { status: 400 })
  }

  // 消毒：截断字段、白名单 url、限制条数，只落盘干净结构（不写原始 body）
  const src = report as Record<string, unknown>
  const papers = (report.papers as unknown[])
    .slice(0, MAX_PAPERS)
    .map((raw, i) => {
      const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      return {
        index: typeof p.index === 'number' ? p.index : i + 1,
        title: clampStr(p.title, 300) ?? '',
        arxivId: clampStr(p.arxivId, 40),
        url: safeUrl(p.url),
        published: clampStr(p.published, 20),
        category: clampStr(p.category, 80),
        score: typeof p.score === 'number' ? p.score : undefined,
        finding: clampStr(p.finding, 1200),
        llmLink: clampStr(p.llmLink, 1200),
        insight: clampStr(p.insight, 1200),
      }
    })
    .filter((p) => p.title)

  const sanitized = {
    date: safeDate,
    edition: typeof src.edition === 'number' ? src.edition : undefined,
    summary: clampStr(src.summary, 600),
    papers,
    generatedAt: new Date().toISOString(),
  }

  try {
    await fs.mkdir(DIR, { recursive: true })
    await fs.writeFile(
      path.join(DIR, `report-${safeDate}.json`),
      JSON.stringify(sanitized),
      'utf-8',
    )
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `写入失败: ${(e as Error).message}` },
      { status: 500 },
    )
  }

  revalidatePath('/radar')
  return NextResponse.json({ ok: true, date: safeDate, papers: papers.length })
}

// GithubRadarReport 消毒 + 落盘（与 theory 同级安全标准：截断/白名单 url/限条数/防路径穿越）
async function handleGithubReport(body: unknown) {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const rawDate = typeof src.date === 'string' ? src.date : ''
  const safeDate = rawDate.replace(/[^0-9-]/g, '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
    return NextResponse.json({ ok: false, error: 'date 格式应为 YYYY-MM-DD' }, { status: 400 })
  }
  if (!Array.isArray(src.categories) || src.categories.length === 0) {
    return NextResponse.json({ ok: false, error: '缺少 categories' }, { status: 400 })
  }

  const categories = (src.categories as unknown[])
    .slice(0, MAX_CATEGORIES)
    .map((raw) => {
      const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const repos = (Array.isArray(c.repos) ? c.repos : [])
        .slice(0, MAX_REPOS_PER_CATEGORY)
        .map((r0) => {
          const r = (r0 && typeof r0 === 'object' ? r0 : {}) as Record<string, unknown>
          return {
            name: clampStr(r.name, 140) ?? '',
            url: safeUrl(r.url),
            stars: typeof r.stars === 'number' && Number.isFinite(r.stars) ? r.stars : 0,
            description: clampStr(r.description, 300),
            language: clampStr(r.language, 40),
            updated: clampStr(r.updated, 10),
          }
        })
        .filter((r) => r.name && r.url)
      return { label: clampStr(c.label, 60) ?? '', repos }
    })
    .filter((c) => c.label && c.repos.length > 0)

  if (categories.length === 0) {
    return NextResponse.json({ ok: false, error: 'categories 全部无效' }, { status: 400 })
  }

  const judgments = (Array.isArray(src.judgments) ? src.judgments : [])
    .slice(0, MAX_JUDGMENTS)
    .map((raw) => {
      const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      return { repo: clampStr(j.repo, 140) ?? '', reason: clampStr(j.reason, 400) ?? '' }
    })
    .filter((j) => j.repo && j.reason)

  const sanitized = {
    date: safeDate,
    generatedAt: new Date().toISOString(),
    categories,
    ...(judgments.length > 0 ? { judgments } : {}),
  }

  try {
    await fs.mkdir(GITHUB_DIR, { recursive: true })
    await fs.writeFile(
      path.join(GITHUB_DIR, `report-${safeDate}.json`),
      JSON.stringify(sanitized),
      'utf-8',
    )
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `写入失败: ${(e as Error).message}` },
      { status: 500 },
    )
  }

  revalidatePath('/radar')
  const repoCount = categories.reduce((n, c) => n + c.repos.length, 0)
  return NextResponse.json({ ok: true, type: 'github', date: safeDate, repos: repoCount })
}
