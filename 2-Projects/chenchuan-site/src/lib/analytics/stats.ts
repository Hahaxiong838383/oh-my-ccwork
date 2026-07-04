import 'server-only'
import { getDb } from './db'
import type { DashboardStats } from './types'

interface CountRow {
  c: number
}

// 一次性聚合查询出 dashboard 所有数据。SQLite 同步 API + 索引（ts/path/country），
// 总查询 < 10ms（个人站量级）。失败由调用方 try/catch（route handler）。
export function getStats(): DashboardStats {
  const db = getDb()
  const now = Date.now()
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000

  const todayPv = db
    .prepare('SELECT COUNT(*) AS c FROM visits WHERE ts >= ?')
    .get(startOfToday) as CountRow
  const todayUv = db
    .prepare('SELECT COUNT(DISTINCT ip_hash) AS c FROM visits WHERE ts >= ?')
    .get(startOfToday) as CountRow
  const weekPv = db
    .prepare('SELECT COUNT(*) AS c FROM visits WHERE ts >= ?')
    .get(sevenDaysAgo) as CountRow
  const weekUv = db
    .prepare('SELECT COUNT(DISTINCT ip_hash) AS c FROM visits WHERE ts >= ?')
    .get(sevenDaysAgo) as CountRow

  // 7 天日级 trend：按本地日期分组
  const trend = db
    .prepare(
      `SELECT
        date(ts/1000, 'unixepoch', 'localtime') AS date,
        COUNT(*) AS pv,
        COUNT(DISTINCT ip_hash) AS uv
      FROM visits
      WHERE ts >= ?
      GROUP BY date
      ORDER BY date ASC`,
    )
    .all(sevenDaysAgo) as Array<{ date: string; pv: number; uv: number }>

  const topPaths = db
    .prepare(
      `SELECT path, COUNT(*) AS count
      FROM visits
      WHERE ts >= ?
      GROUP BY path
      ORDER BY count DESC
      LIMIT 10`,
    )
    .all(sevenDaysAgo) as Array<{ path: string; count: number }>

  const topReferrers = db
    .prepare(
      `SELECT
        CASE WHEN referrer IS NULL OR referrer = '' THEN '(直接访问)'
             ELSE substr(referrer, 1, 80) END AS referrer,
        COUNT(*) AS count
      FROM visits
      WHERE ts >= ?
      GROUP BY referrer
      ORDER BY count DESC
      LIMIT 10`,
    )
    .all(sevenDaysAgo) as Array<{ referrer: string; count: number }>

  const topCountries = db
    .prepare(
      `SELECT
        COALESCE(country, '未知') AS country,
        COUNT(*) AS count
      FROM visits
      WHERE ts >= ?
      GROUP BY country
      ORDER BY count DESC
      LIMIT 10`,
    )
    .all(sevenDaysAgo) as Array<{ country: string; count: number }>

  const recent = db
    .prepare(
      `SELECT ts, path, referrer, country, ip
      FROM visits
      ORDER BY ts DESC
      LIMIT 50`,
    )
    .all() as Array<{
      ts: number
      path: string
      referrer: string | null
      country: string | null
      ip: string | null
    }>

  return {
    today: { pv: todayPv.c, uv: todayUv.c },
    week: { pv: weekPv.c, uv: weekUv.c },
    trend,
    topPaths,
    topReferrers,
    topCountries,
    recent,
  }
}
