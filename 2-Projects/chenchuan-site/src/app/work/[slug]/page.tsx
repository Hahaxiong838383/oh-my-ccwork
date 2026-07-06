import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { BlurFade } from '@/components/ui/BlurFade'
import { Tag } from '@/components/shared/Tag'
import { getProjects, getProjectBySlug } from '@/lib/data'
import { projects as localProjects } from '@/data/projects'

interface Props {
  params: Promise<{ slug: string }>
}

export const revalidate = 60

export async function generateStaticParams() {
  const { projects: local } = await import('@/data/projects')
  const cmsProjects = await getProjects()
  const slugs = new Set([
    ...local.map((p) => p.slug),
    ...cmsProjects.map((p) => p.slug),
  ])
  return Array.from(slugs).map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const project = await getProjectBySlug(slug)
  return { title: project?.title ?? '项目详情' }
}

function getVideoPoster(url: string, poster?: string): string | undefined {
  if (poster) return poster
  if (!url.startsWith('/media-optimized/') || !url.endsWith('.mp4')) return undefined
  return url.replace('/media-optimized/', '/media-posters/').replace(/\.mp4$/, '.jpg')
}

function getRelatedProjects(slugs: string[]) {
  return slugs
    .map((s) => localProjects.find((p) => p.slug === s))
    .filter(Boolean)
}

export default async function ProjectDetailPage({ params }: Props) {
  const { slug } = await params
  const project = await getProjectBySlug(slug)
  if (!project) notFound()

  const relatedProjects = project.relatedSlugs
    ? getRelatedProjects(project.relatedSlugs)
    : []

  return (
    <div className="pt-24">
      <SectionWrapper>
        <BlurFade>
          <Link
            href="/work"
            className="mb-8 inline-block text-sm text-text-secondary transition-colors hover:text-accent"
          >
            &larr; 返回全部项目
          </Link>
        </BlurFade>

        <BlurFade delay={0.1}>
          <div className="mb-3 flex items-center gap-3">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: project.color }}
            />
            <span className="font-mono text-sm text-text-muted">{project.year}</span>
          </div>
        </BlurFade>

        <BlurFade delay={0.15}>
          <h1 className="mb-2 text-3xl font-bold tracking-tight text-text-primary md:text-5xl">
            {project.title}
          </h1>
        </BlurFade>

        <BlurFade delay={0.2}>
          <p className="mb-2 text-lg text-text-secondary">{project.subtitle}</p>
          <p className="mb-6 text-sm text-accent">
            {project.company} · {project.role}
          </p>
        </BlurFade>

        <BlurFade delay={0.25}>
          <div className="mb-8 flex flex-wrap gap-1.5">
            {project.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        </BlurFade>

        {/* Description - support \n as paragraphs */}
        <BlurFade delay={0.3}>
          <div className="mx-auto mb-12 max-w-3xl space-y-4">
            {project.fullDescription.split('\n\n').map((para, i) => (
              <p key={i} className="text-base leading-relaxed text-text-secondary">
                {para}
              </p>
            ))}
          </div>
        </BlurFade>

        {/* Highlights */}
        <BlurFade delay={0.35}>
          <div className="mb-12 rounded-xl border border-white/[0.06] bg-bg-card p-6">
            <h3 className="mb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
              Key Highlights
            </h3>
            <ul className="space-y-2.5">
              {project.highlights.map((h) => (
                <li key={h} className="flex items-start gap-2 text-sm text-text-secondary">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                  {h}
                </li>
              ))}
            </ul>
          </div>
        </BlurFade>

        {/* Wins */}
        {project.wins.length > 0 && (
          <BlurFade delay={0.4}>
            <div className="mb-12">
              <h3 className="mb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
                Key Wins
              </h3>
              <div className="flex flex-wrap gap-2">
                {project.wins.map((win) => (
                  <Tag key={win} variant="teal">{win}</Tag>
                ))}
              </div>
            </div>
          </BlurFade>
        )}

        {/* Videos */}
        {project.videos && project.videos.length > 0 && (
          <BlurFade delay={0.45}>
            <div className="mb-12">
              <h3 className="mb-6 font-mono text-xs uppercase tracking-widest text-text-muted">
                Video Demos
              </h3>
              <div className="grid gap-4 md:grid-cols-2">
                {project.videos.map((v) => (
                  <div
                    key={v.url}
                    className="overflow-hidden rounded-xl border border-white/[0.06] bg-bg-card"
                  >
                    <video
                      src={v.url}
                      controls
                      preload="metadata"
                      poster={getVideoPoster(v.url, 'poster' in v ? v.poster : undefined)}
                      playsInline
                      className="block h-auto max-h-[72vh] w-full bg-black object-contain"
                    />
                    <div className="flex items-center justify-between px-4 py-3">
                      <span className="text-sm text-text-primary">{v.title}</span>
                      <span className="font-mono text-[11px] text-text-muted">{v.duration}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </BlurFade>
        )}

        {/* Images */}
        {project.images && project.images.length > 0 && (
          <BlurFade delay={0.48}>
            <div className="mb-12">
              <h3 className="mb-6 font-mono text-xs uppercase tracking-widest text-text-muted">
                Gallery
              </h3>
              <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
                {project.images.map((src) => (
                  <a key={src} href={src} target="_blank" rel="noopener noreferrer">
                    <img
                      src={src}
                      alt=""
                      loading="lazy"
                      className="aspect-square w-full rounded-lg border border-white/[0.06] object-cover transition-all duration-300 hover:border-white/[0.12] hover:brightness-110"
                    />
                  </a>
                ))}
              </div>
            </div>
          </BlurFade>
        )}

        {/* Related Projects */}
        {relatedProjects.length > 0 && (
          <BlurFade delay={0.5}>
            <div className="mb-12">
              <h3 className="mb-6 font-mono text-xs uppercase tracking-widest text-text-muted">
                Related Projects
              </h3>
              <div className="grid gap-4 md:grid-cols-2">
                {relatedProjects.map((rp) => (
                  <Link key={rp!.slug} href={`/work/${rp!.slug}`}>
                    <div className="group rounded-xl border border-white/[0.06] bg-bg-card p-5 transition-all duration-300 hover:border-white/[0.1] hover:-translate-y-0.5">
                      <div className="mb-2 flex items-center gap-2">
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: rp!.color }}
                        />
                        <span className="font-mono text-[11px] text-text-muted">{rp!.year}</span>
                      </div>
                      <h4 className="mb-1 text-base font-semibold text-text-primary transition-colors group-hover:text-accent">
                        {rp!.title}
                      </h4>
                      <p className="text-sm text-text-secondary">{rp!.subtitle}</p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {rp!.tags.slice(0, 4).map((tag) => (
                          <Tag key={tag}>{tag}</Tag>
                        ))}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </BlurFade>
        )}
      </SectionWrapper>
    </div>
  )
}
