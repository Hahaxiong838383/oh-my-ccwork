import { NextResponse } from 'next/server'
import { getDailyBudget, getDailyRemainingCents } from '@/lib/chat/budget'
import { isIpBlacklisted } from '@/lib/chat/blacklist'
import { getQuotaStatus, hashIp, resolveClientIp } from '@/lib/chat/quota'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const cookieId = (url.searchParams.get('cookie_id') ?? '').trim()
  if (!cookieId) {
    return NextResponse.json({ error: 'missing_cookie_id' }, { status: 400 })
  }

  const ip = resolveClientIp(req.headers)
  const ipHash = hashIp(ip)

  const quota = getQuotaStatus(cookieId, ipHash)
  const budget = getDailyBudget()
  const blacklist = isIpBlacklisted(ipHash)

  return NextResponse.json({
    remaining: quota.remaining,
    daily_cents_remaining: getDailyRemainingCents(budget),
    blacklisted: blacklist.blacklisted,
  })
}
