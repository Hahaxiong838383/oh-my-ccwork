import type { Metadata } from 'next'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { Glow } from '@/components/ui/Glow'
import { getProfile } from '@/lib/data'
import { Mail, MapPin, Phone } from 'lucide-react'

export const metadata: Metadata = { title: '联系' }
export const revalidate = 60

export default async function ContactPage() {
  const profile = await getProfile()

  return (
    <div className="pt-24">
      <SectionWrapper className="relative overflow-hidden">
        <Glow className="left-1/2 top-0 -translate-x-1/2" size="600px" />

        <div className="relative z-10">
          <SectionTitle label="联系" title="联系方式" />

          <div className="mx-auto max-w-2xl">
            <BlurFade>
              <p className="mb-12 text-lg text-text-secondary">
                想聊产品合作或技术方案，可以通过邮箱联系我。
              </p>
            </BlurFade>

            <div className="grid gap-4 md:grid-cols-3">
              <BlurFade delay={0.1}>
                <div className="depth-panel rounded-xl border border-border bg-bg-card p-6 text-center">
                  <Mail size={20} className="mx-auto mb-3 text-accent" />
                  <div className="mb-1 text-xs text-text-muted">邮箱</div>
                  <a
                    href={`mailto:${profile.contact.email}`}
                    className="text-sm text-text-secondary transition-colors hover:text-accent"
                  >
                    {profile.contact.email}
                  </a>
                </div>
              </BlurFade>

              <BlurFade delay={0.15}>
                <div className="depth-panel rounded-xl border border-border bg-bg-card p-6 text-center">
                  <Phone size={20} className="mx-auto mb-3 text-accent" />
                  <div className="mb-1 text-xs text-text-muted">电话</div>
                  <span className="text-sm text-text-secondary">{profile.contact.phone}</span>
                </div>
              </BlurFade>

              <BlurFade delay={0.2}>
                <div className="depth-panel rounded-xl border border-border bg-bg-card p-6 text-center">
                  <MapPin size={20} className="mx-auto mb-3 text-accent" />
                  <div className="mb-1 text-xs text-text-muted">所在地</div>
                  <span className="text-sm text-text-secondary">{profile.contact.location}</span>
                </div>
              </BlurFade>
            </div>

            <BlurFade delay={0.3}>
              <div className="mt-12 flex justify-center gap-6">
                {[
                  { label: 'LinkedIn', href: profile.contact.linkedin },
                  { label: 'GitHub', href: profile.contact.github },
                ].filter((link) => link.href && !link.href.includes('yourprofile')).map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-text-secondary transition-colors hover:text-accent"
                  >
                    {link.label} &nearr;
                  </a>
                ))}
              </div>
            </BlurFade>

          </div>
        </div>
      </SectionWrapper>
    </div>
  )
}
