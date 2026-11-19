import type { Metadata } from 'next'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { Tag } from '@/components/shared/Tag'
import { getProfile } from '@/lib/data'

export const metadata: Metadata = { title: '关于' }
export const revalidate = 60

export default async function AboutPage() {
  const profile = await getProfile()

  return (
    <div className="pt-24">
      <SectionWrapper>
        <SectionTitle label="About" title="关于我" />

        {/* Profile Cards */}
        <div className="mb-16 grid gap-4 md:grid-cols-2">
          {profile.profileCards.map((card, i) => (
            <BlurFade key={card.id} delay={i * 0.08}>
              <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6">
                <div className="mb-3 font-mono text-xs text-accent">
                  {card.id} · {card.label}
                </div>
                <p className="text-sm leading-relaxed text-text-secondary">{card.text}</p>
              </div>
            </BlurFade>
          ))}
        </div>

        <BlurFade delay={0.3}>
          <div className="mx-auto mb-16 max-w-3xl">
            <p className="mb-6 text-lg leading-relaxed text-text-secondary">{profile.bio}</p>
            <p className="text-base leading-relaxed text-text-secondary">{profile.bioExtended}</p>
          </div>
        </BlurFade>

        <BlurFade delay={0.4}>
          <div className="mb-16">
            <h3 className="mb-6 font-mono text-xs uppercase tracking-widest text-text-muted">
              我参与的工作
            </h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {profile.coreSkills.map((skill) => (
                <div key={skill.label} className="rounded-lg border border-white/[0.04] p-4">
                  <div className="mb-1 text-sm font-medium text-text-primary">{skill.label}</div>
                  <div className="text-xs text-text-muted">{skill.detail}</div>
                </div>
              ))}
            </div>
          </div>
        </BlurFade>

        <BlurFade delay={0.5}>
          <div className="mb-16">
            <h3 className="mb-6 font-mono text-xs uppercase tracking-widest text-text-muted">
              不同项目里用到的技术
            </h3>
            <div className="space-y-3">
              {[
                { layer: '机器人', detail: '用 SLAM 定位导航，结合视觉、避障和机械控制完成现场任务。' },
                { layer: '儿童 AI', detail: 'Kotlin 对接硬件，Godot 展示成长世界，Rust 分别负责语音引擎和游戏状态。' },
                { layer: '团队助手', detail: 'Node.js 运行任务，SQLite 保存状态；全文与向量检索为任务找资料。' },
                { layer: 'AR HUD', detail: '把光学约束转为显示与交互需求，用 Swift / Metal 验证曲面预畸变。' },
              ].map((item) => (
                <div key={item.layer} className="flex items-start gap-3">
                  <Tag variant="accent">{item.layer}</Tag>
                  <span className="text-sm text-text-secondary">{item.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </BlurFade>

        <BlurFade delay={0.6}>
          <div className="mb-16">
            <h3 className="mb-6 font-mono text-xs uppercase tracking-widest text-text-muted">
              教育经历
            </h3>
            <div className="space-y-3">
              {profile.education.map((edu) => (
                <div
                  key={edu.year}
                  className="flex items-center justify-between rounded-lg border border-white/[0.04] bg-bg-card px-5 py-3"
                >
                  <div>
                    <div className="text-sm font-medium text-text-primary">{edu.school}</div>
                    <div className="text-xs text-text-secondary">
                      {edu.degree} · {edu.tag}
                    </div>
                  </div>
                  <span className="font-mono text-xs text-text-muted">{edu.year}</span>
                </div>
              ))}
            </div>
          </div>
        </BlurFade>

        <BlurFade delay={0.7}>
          <div>
            <h3 className="mb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
              认证与语言
            </h3>
            <ul className="space-y-1.5">
              {profile.certifications.map((cert) => (
                <li key={cert} className="text-sm text-text-secondary">{cert}</li>
              ))}
            </ul>
          </div>
        </BlurFade>
      </SectionWrapper>
    </div>
  )
}
