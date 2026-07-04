import { NextResponse } from 'next/server'
import { getClassicDemoById } from '@/lib/chat/demos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  const demo = getClassicDemoById(id)

  if (!demo) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const totalDurationMs = demo.routing.reduce((sum, step) => {
    const value = Number(step.duration_ms)
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0)

  return NextResponse.json({
    id: demo.id,
    category: demo.category,
    question: demo.question,
    routing: demo.routing,
    total_duration_ms: totalDurationMs,
  })
}
