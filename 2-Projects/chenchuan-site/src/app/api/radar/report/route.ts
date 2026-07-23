import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RADAR_DIR = process.env.RADAR_DATA_DIR || path.join(process.cwd(), 'data', 'radar')
const REPORT_FILE_RE = /^report-(\d{4}-\d{2}-\d{2})\.json$/

function noStoreJson(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function latestReportDate(): Promise<string | null> {
  const files = await fs.readdir(RADAR_DIR)
  const dates = files
    .map((file) => REPORT_FILE_RE.exec(file)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort()

  return dates.at(-1) ?? null
}

export async function GET(req: NextRequest) {
  const requestedDate = req.nextUrl.searchParams.get('date')?.trim()
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return noStoreJson({ ok: false, error: 'date 格式应为 YYYY-MM-DD' }, 400)
  }

  try {
    const reportDate = requestedDate || (await latestReportDate())
    if (!reportDate) {
      return noStoreJson({ ok: false, error: '暂无理论雷达报告' }, 404)
    }

    const raw = await fs.readFile(path.join(RADAR_DIR, `report-${reportDate}.json`), 'utf-8')
    const report = JSON.parse(raw) as { date?: unknown; papers?: unknown }
    if (report.date !== reportDate || !Array.isArray(report.papers) || report.papers.length === 0) {
      return noStoreJson({ ok: false, error: '理论雷达报告格式无效' }, 500)
    }

    return NextResponse.json(
      { ok: true, report },
      {
        headers: {
          'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=900',
        },
      },
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return noStoreJson({ ok: false, error: '指定日期暂无理论雷达报告' }, 404)
    }
    return noStoreJson({ ok: false, error: '读取理论雷达报告失败' }, 500)
  }
}
