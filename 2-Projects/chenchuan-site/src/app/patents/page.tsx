import type { Metadata } from 'next'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { NumberTicker } from '@/components/ui/NumberTicker'
import type { Patent } from '@/data/patents'
import { getPatents } from '@/lib/data'

export const metadata: Metadata = { title: '专利' }
export const revalidate = 60

function PatentRow({ patent }: { patent: Patent }) {
  const statusClass =
    patent.status === '发明授权'
      ? 'bg-emerald-500/10 text-emerald-500'
      : patent.status === '发明'
        ? 'bg-accent/10 text-accent'
        : 'bg-orange-500/10 text-orange-500'

  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <span className={`mt-0.5 shrink-0 rounded-sm px-2 py-0.5 font-mono text-[10px] ${statusClass}`}>
        {patent.statusLabel}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-text-primary">{patent.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-muted">
          <a
            href={`https://patents.google.com/patent/${patent.number}/zh`}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-accent"
          >
            {patent.number}
          </a>
          <span>{patent.company}</span>
          <span>申请 {patent.filingDate}</span>
          {patent.inventorRole === '合作发明人' && (
            <span className="text-amber-500">合作发明人</span>
          )}
        </div>
      </div>
    </div>
  )
}

export default async function PatentsPage() {
  const patents = await getPatents()
  const inventions = patents.filter((p) => p.status === '发明' || p.status === '发明授权')
  const utilities = patents.filter((p) => p.status === '实用新型')
  const leadInventorCount = patents.filter((p) => p.inventorRole === '首位发明人').length
  const collaborativeCount = patents.length - leadInventorCount

  return (
    <div className="pt-24">
      <SectionWrapper>
        <SectionTitle label="Patents · Innovation" title="专利创新" />

        <BlurFade>
          <div className="mb-12 flex items-end gap-3">
            <span className="text-5xl font-bold text-text-primary">
              <NumberTicker value={patents.length} />
            </span>
            <div className="mb-1">
              <div className="text-lg text-text-secondary">项专利</div>
              <div className="font-mono text-[11px] text-text-muted">
                {leadInventorCount} 项首位发明人 · {collaborativeCount} 项合作发明人
              </div>
            </div>
          </div>
        </BlurFade>

        <BlurFade delay={0.1}>
          <div className="mb-10">
            <h3 className="mb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
              发明专利（{inventions.length} 项）
            </h3>
            <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden divide-y divide-white/[0.04]">
              {inventions.map((patent) => (
                <PatentRow key={patent.number} patent={patent} />
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
                <PatentRow key={patent.number} patent={patent} />
              ))}
            </div>
          </div>
        </BlurFade>
      </SectionWrapper>
    </div>
  )
}
