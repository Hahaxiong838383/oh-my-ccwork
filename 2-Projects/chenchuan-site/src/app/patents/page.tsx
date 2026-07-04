import type { Metadata } from 'next'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { NumberTicker } from '@/components/ui/NumberTicker'
import { getPatents } from '@/lib/data'

export const metadata: Metadata = { title: '专利' }
export const revalidate = 60

export default async function PatentsPage() {
  const patents = await getPatents()
  const inventions = patents.filter((p) => p.status === '发明' || p.status === '发明授权')
  const utilities = patents.filter((p) => p.status === '实用新型')

  return (
    <div className="pt-24">
      <SectionWrapper>
        <SectionTitle label="Patents · Innovation" title="专利创新" />

        <BlurFade>
          <div className="mb-12 flex items-end gap-3">
            <span className="text-5xl font-bold text-text-primary">
              <NumberTicker value={patents.length} />
            </span>
            <span className="mb-1 text-lg text-text-secondary">项专利</span>
          </div>
        </BlurFade>

        <BlurFade delay={0.1}>
          <div className="mb-10">
            <h3 className="mb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
              发明专利（{inventions.length} 项）
            </h3>
            <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden divide-y divide-white/[0.04]">
              {inventions.map((patent) => (
                <div key={patent.number} className="flex items-start gap-3 px-5 py-4">
                  <span
                    className={`mt-0.5 shrink-0 rounded-sm px-2 py-0.5 font-mono text-[10px] ${
                      patent.status === '发明授权'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-accent/10 text-accent'
                    }`}
                  >
                    {patent.statusLabel}
                  </span>
                  <div>
                    <div className="text-sm text-text-primary">{patent.title}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-text-muted">
                      {patent.number}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </BlurFade>

        <BlurFade delay={0.2}>
          <div>
            <h3 className="mb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
              实用新型（{utilities.length} 项）
            </h3>
            <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden divide-y divide-white/[0.04]">
              {utilities.map((patent) => (
                <div key={patent.number} className="flex items-start gap-3 px-5 py-4">
                  <span className="mt-0.5 shrink-0 rounded-sm bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-text-muted">
                    {patent.statusLabel}
                  </span>
                  <div>
                    <div className="text-sm text-text-primary">{patent.title}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-text-muted">
                      {patent.number}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </BlurFade>
      </SectionWrapper>
    </div>
  )
}
