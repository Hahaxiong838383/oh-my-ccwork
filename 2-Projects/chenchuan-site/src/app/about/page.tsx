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
              Core Skills
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
              Embodied AI Stack
            </h3>
            <div className="space-y-3">
              {[
                { layer: '感知', detail: '激光雷达 SLAM · 双目视觉 · ToF · DLP' },
                { layer: '规划', detail: '自主路径规划 · 避障算法 · 空间感知' },
                { layer: '交互', detail: '语音 NLU · 人脸/骨骼识别 · 情感计算' },
                { layer: '云端', detail: 'Azure AI · 国产 LLM · 个性化推荐' },
                { layer: '执行', detail: 'UR 协作机械臂 · 舵机控制 · 无线充电' },
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
              Education
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
              Certifications
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
