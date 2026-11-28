'use client'

import { TaskRouterCard } from '@/components/shared/TaskRouterCard'
import Link from 'next/link'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { MagicCard } from '@/components/ui/MagicCard'
import { Tag } from '@/components/shared/Tag'
import type { Project } from '@/data/projects'

interface Props {
  projects: Project[]
}

export function ProjectGrid({ projects }: Props) {
  const featured = projects.filter((p) => p.featured).slice(0, 6)

  return (
    <SectionWrapper id="work">
      <SectionTitle label="精选项目" title="代表作品" />
      <TaskRouterCard />
      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {featured.map((project, i) => (
          <BlurFade key={project.slug} delay={i * 0.08}>
            <Link href={`/work/${project.slug}`}>
              <MagicCard
                className="group h-full cursor-pointer"
                gradientColor={`${project.color}20`}
              >
                {project.slug === 'ai-hardware-voice-prototype' ? (
                  <div className="p-6">
                    <img src="/media/kidshub-20261126/home.webp" width={400} height={240} loading="lazy" decoding="async" alt="小可在读写台上的活动主界面" className="mb-4 aspect-[5/3] w-full rounded-lg object-cover" />
                    <h3 className="mb-2 text-lg font-semibold text-text-primary">{project.title}</h3>
                    <p className="text-sm leading-relaxed text-text-secondary">孩子在读写台上和小可聊天，也照料自己的成长世界。过几周再开口，小可还记得上次聊过什么吗？</p>
                    <span className="mt-4 inline-block text-sm font-medium text-accent">看产品界面和内测实录 →</span>
                  </div>
                ) : project.slug === 'h-platform-ai-assistant' ? (
                  <div className="p-6">
                    <h3 className="mb-2 text-lg font-semibold text-text-primary">{project.title}</h3>
                    <p className="text-sm leading-relaxed text-text-secondary">{project.description}</p>
                    <img src="/h-platform-case/card.webp" width={500} height={146} loading="lazy" decoding="async" alt="H 平台技能列表局部，个人和部门的方法并排显示" className="my-4 w-full rounded-md border border-border" />
                    <span className="text-sm font-medium text-accent">看助手界面与跨部门交接 →</span>
                  </div>
                ) : (
                <div className="p-6">
                  <div className="mb-3 flex items-center gap-2">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="font-mono text-[11px] text-text-muted">
                      {project.year}
                    </span>
                  </div>

                  <h3 className="mb-1.5 text-lg font-semibold text-text-primary transition-colors group-hover:text-accent">
                    {project.title}
                  </h3>
                  <p className="mb-1 text-xs text-text-secondary">{project.company}</p>
                  <p className="mb-4 text-sm leading-relaxed text-text-secondary">
                    {project.subtitle}
                  </p>

                  <div className="mb-4 flex flex-wrap gap-1.5">
                    {project.tags.slice(0, 4).map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </div>

                  {project.brief ? (
                    <div
                      className="rounded-md border border-border bg-bg-secondary p-3 text-[12px] leading-relaxed"
                    >
                      <BriefRow label="问题" tint={project.color} text={project.brief.problem} />
                      <BriefRow label="方案" tint={project.color} text={project.brief.solution} />
                      <BriefRow label="技术" tint={project.color} text={project.brief.stack} />
                      <BriefRow label="进展" tint={project.color} text={project.brief.result} highlight />
                    </div>
                  ) : project.wins.length > 0 ? (
                    <div className="mt-4 border-t border-border pt-3">
                      {project.wins.slice(0, 2).map((win) => (
                        <div
                          key={win}
                          className="flex items-center gap-1.5 text-[11px] text-emerald-600"
                        >
                          <span className="text-[8px]">&#9650;</span>
                          {win}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                )}
              </MagicCard>
            </Link>
          </BlurFade>
        ))}
      </div>

      {/* 体验式 Live Demo 已上移到 Hero 下方独立的「Live AI Lab」三连专区（LiveDemoLab.tsx），
          此处作品区回归纯作品流，不再重复 demo 入口卡 */}

      <BlurFade delay={0.6}>
        <div className="mt-6 text-center">
          <Link
            href="/work"
            className="text-sm text-text-secondary transition-colors hover:text-accent"
          >
            查看全部项目 &rarr;
          </Link>
        </div>
      </BlurFade>
    </SectionWrapper>
  )
}

function BriefRow({
  label,
  tint,
  text,
  highlight = false,
}: {
  label: string
  tint: string
  text: string
  highlight?: boolean
}) {
  return (
    <div className="mb-1.5 grid grid-cols-[32px_1fr] items-baseline gap-2 last:mb-0">
      <span
        className="font-mono text-[10px] uppercase tracking-[0.12em]"
        style={{ color: tint }}
      >
        {label}
      </span>
      <span className={highlight ? 'text-text-primary' : 'text-text-secondary'}>
        {text}
      </span>
    </div>
  )
}
