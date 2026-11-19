import Link from 'next/link'
import { profile } from '@/data/profile'

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-content px-6 py-12 md:px-8">
        <div className="grid gap-8 md:grid-cols-3">
          <div>
            <div className="mb-2 font-semibold text-text-primary">陈川</div>
            <p className="text-sm leading-relaxed text-text-secondary">
              {profile.title}
              <br />
              {profile.tagline}
            </p>
          </div>

          <div>
            <div className="mb-3 font-mono text-xs uppercase tracking-widest text-text-muted">
              导航
            </div>
            <ul className="space-y-1.5 text-sm text-text-secondary">
              {[
                ['关于', '/about'],
                ['作品', '/work'],
                ['视频', '/videos'],
                ['思考', '/writing'],
                ['专利', '/patents'],
              ].map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="transition-colors hover:text-text-primary">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="mb-3 font-mono text-xs uppercase tracking-widest text-text-muted">
              联系
            </div>
            <ul className="space-y-1.5 font-mono text-sm text-text-secondary">
              <li>{profile.contact.email}</li>
              <li>{profile.contact.location}</li>
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-border pt-6">
          <p className="text-center font-mono text-xs text-text-muted">
            &copy; {new Date().getFullYear()} 陈川 · 使用 Next.js 与 AI 辅助开发
          </p>
        </div>
      </div>
    </footer>
  )
}
