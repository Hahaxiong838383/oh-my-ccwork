import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { BlurFade } from '@/components/ui/BlurFade'
import { Tag } from '@/components/shared/Tag'
import { ArticleBody } from '@/components/writing/ArticleBody'
import { getArticles, getArticleBySlug } from '@/lib/data'

interface Props {
  params: Promise<{ slug: string }>
}

export const revalidate = 60

export async function generateStaticParams() {
  const { articles: localArticles } = await import('@/data/articles')
  const cmsArticles = await getArticles()
  const slugs = new Set([
    ...localArticles.map((a) => a.slug),
    ...cmsArticles.map((a) => a.slug),
  ])
  return Array.from(slugs).map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const article = await getArticleBySlug(slug)
  return { title: article?.title ?? '文章详情' }
}

export default async function ArticleDetailPage({ params }: Props) {
  const { slug } = await params
  const article = await getArticleBySlug(slug)
  if (!article) notFound()

  return (
    <div className="pt-24">
      <SectionWrapper>
        <BlurFade>
          <Link
            href="/writing"
            className="mb-8 inline-block text-sm text-text-secondary transition-colors hover:text-accent"
          >
            &larr; 返回全部文章
          </Link>
        </BlurFade>

        <BlurFade delay={0.1}>
          <div className="mb-4 flex items-center gap-3">
            <span className="font-mono text-sm text-text-muted">{article.date}</span>
            <div className="flex gap-1.5">
              {article.tags.map((tag) => (
                <Tag key={tag} variant="accent">{tag}</Tag>
              ))}
            </div>
          </div>
        </BlurFade>

        <BlurFade delay={0.15}>
          <h1 className="mb-8 text-3xl font-bold tracking-tight text-text-primary md:text-4xl">
            {article.title}
          </h1>
        </BlurFade>

        <BlurFade delay={0.2}>
          <div className="mx-auto max-w-3xl">
            <p className="text-lg leading-relaxed text-text-secondary">{article.excerpt}</p>
            <hr className="my-8 border-border" />
            <ArticleBody content={article.content} />
          </div>
        </BlurFade>
      </SectionWrapper>
    </div>
  )
}
