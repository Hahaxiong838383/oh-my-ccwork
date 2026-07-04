import type { Metadata } from 'next'
import Link from 'next/link'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { Tag } from '@/components/shared/Tag'
import { getArticles } from '@/lib/data'

export const metadata: Metadata = { title: '思考' }
export const revalidate = 60

export default async function WritingPage() {
  const articles = await getArticles()

  return (
    <div className="pt-24">
      <SectionWrapper>
        <SectionTitle label="Writing / Thinking" title="思考与写作" />

        <div className="space-y-6">
          {articles.map((article, i) => (
            <BlurFade key={article.slug} delay={i * 0.08}>
              <Link href={`/writing/${article.slug}`}>
                <article className="group rounded-xl border border-white/[0.06] bg-bg-card p-6 transition-all hover:border-white/[0.1] hover:-translate-y-0.5">
                  <div className="mb-2 flex items-center gap-3">
                    <span className="font-mono text-xs text-text-muted">{article.date}</span>
                    <div className="flex gap-1.5">
                      {article.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </div>
                  </div>
                  <h3 className="mb-2 text-lg font-semibold text-text-primary transition-colors group-hover:text-accent">
                    {article.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-text-secondary">{article.excerpt}</p>
                </article>
              </Link>
            </BlurFade>
          ))}
        </div>
      </SectionWrapper>
    </div>
  )
}
