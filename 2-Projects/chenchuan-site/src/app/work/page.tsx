import type { Metadata } from 'next'
import Link from 'next/link'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { MagicCard } from '@/components/ui/MagicCard'
import { Tag } from '@/components/shared/Tag'
import { getProjects } from '@/lib/data'

export const metadata: Metadata = { title: '作品' }
export const revalidate = 60

export default async function WorkPage() {
  const projects = await getProjects()

  return (
    <div className="pt-24">
      <SectionWrapper>
        <SectionTitle label="All Work" title="全部项目" />
        <div className="grid gap-6 md:grid-cols-2">
          {projects.map((project, i) => (
            <BlurFade key={project.slug} delay={i * 0.06}>
              <Link href={`/work/${project.slug}`}>
                <MagicCard
                  className="group h-full cursor-pointer"
                  gradientColor={`${project.color}20`}
                >
                  <div className="p-6">
                    <div className="mb-3 flex items-center gap-2">
                      <div
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: project.color }}
                      />
                      <span className="font-mono text-[11px] text-text-muted">
                        {project.year} · {project.company}
                      </span>
                    </div>
                    <h3 className="mb-2 text-xl font-semibold text-text-primary transition-colors group-hover:text-accent">
                      {project.title}
                    </h3>
                    <p className="mb-1 text-sm text-accent">{project.role}</p>
                    <p className="mb-4 text-sm leading-relaxed text-text-secondary">
                      {project.description}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </div>
                    {project.wins.length > 0 && (
                      <div className="mt-4 border-t border-white/[0.04] pt-3">
                        {project.wins.map((win) => (
                          <div
                            key={win}
                            className="flex items-center gap-1.5 text-[11px] text-emerald-400"
                          >
                            <span className="text-[8px]">&#9650;</span>
                            {win}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </MagicCard>
              </Link>
            </BlurFade>
          ))}
        </div>
      </SectionWrapper>
    </div>
  )
}
