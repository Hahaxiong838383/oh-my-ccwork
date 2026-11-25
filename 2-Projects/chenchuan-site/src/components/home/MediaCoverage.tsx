import Image from 'next/image'
import { ArrowUpRight, Play } from 'lucide-react'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'

const articles = [
  {
    category: '亲子科普',
    title: '爱视可走进蔚来',
    description: '在北京蔚来中心，孩子们动手做光学实验，体验空间光学读写台。',
    url: 'https://mp.weixin.qq.com/s/vc0Hn1XDJX35yF5fX0FLKQ',
  },
  {
    category: '校园实践',
    title: '把护眼学习中心带进校园',
    description: '爱视可与复旦大学附属闵行实验学校共建学习中心，把读写体验带进日常阅读。',
    url: 'https://mp.weixin.qq.com/s/YW-hSjV_XQNXliUwFBWUkA',
  },
  {
    category: '行业展会',
    title: '爱视可亮相 CIOF 眼镜展',
    url: 'https://mp.weixin.qq.com/s/7BYFx-SR54Fj1aO5V6mSTQ',
  },
  {
    category: '微信公众号',
    title: '阅读图文报道',
    url: 'https://mp.weixin.qq.com/s/hZyNARGpV7L0Qq7iVfNNiA',
  },
]

export function MediaCoverage() {
  return (
    <SectionWrapper id="media-news" className="border-b border-border py-12 md:py-14">
      <SectionTitle title="媒体报道" className="mb-6 md:mb-6" />
      <div className="grid gap-6 md:grid-cols-[270px_minmax(0,1fr)] md:gap-10">
        <a
          href="https://weixin.qq.com/sph/Admsqp3Giy"
          target="_blank"
          rel="noopener noreferrer"
          className="group mx-auto w-full max-w-[280px] self-start rounded-lg focus-visible:outline-accent md:max-w-none"
        >
          <div className="relative">
            <Image
              src="/media-posters/transparent-hud-report.webp"
              alt="电动汽车观察家报道封面，展示全透明前挡风玻璃 HUD"
              width={540}
              height={720}
              sizes="(min-width: 768px) 270px, 280px"
              className="h-auto w-full rounded-lg border border-border"
            />
            <span className="absolute bottom-3 right-3 grid size-8 place-items-center rounded-full border border-white/50 bg-black/60 text-white">
              <Play size={14} fill="currentColor" aria-hidden="true" />
            </span>
          </div>
          <h3 className="mt-3 font-semibold text-text-primary group-hover:text-accent">全透明前挡风玻璃 HUD</h3>
          <p className="mt-1 text-xs text-text-secondary">电动汽车观察家 · <time dateTime="2026-11-06">2026.11.06</time></p>
        </a>
        <ul className="grid md:auto-rows-fr">
          {articles.map(({ url, category, title, description }) => (
            <li key={url} className="border-t border-border">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex h-full items-center justify-between gap-4 py-4 focus-visible:outline-accent"
              >
                <div>
                  <p className="text-xs text-text-secondary">{category}</p>
                  <h3 className="mt-1 font-semibold text-text-primary group-hover:text-accent">{title}</h3>
                  {description && <p className="mt-1 text-sm leading-relaxed text-text-secondary">{description}</p>}
                </div>
                <ArrowUpRight size={18} className="shrink-0 text-accent" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </SectionWrapper>
  )
}
