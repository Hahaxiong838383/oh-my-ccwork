export interface VisitRecord {
  id: number
  ts: number
  path: string
  referrer: string | null
  ip_hash: string
  ip: string | null
  ua: string | null
  country: string | null
}

export interface DashboardStats {
  today: {
    pv: number
    uv: number
  }
  week: {
    pv: number
    uv: number
  }
  trend: Array<{
    date: string
    pv: number
    uv: number
  }>
  topPaths: Array<{ path: string; count: number }>
  topReferrers: Array<{ referrer: string; count: number }>
  topCountries: Array<{ country: string; count: number }>
  recent: Array<{
    ts: number
    path: string
    referrer: string | null
    country: string | null
    ip: string | null
  }>
}
