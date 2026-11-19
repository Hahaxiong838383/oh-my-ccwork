'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Hand, MessageSquare, Mic } from 'lucide-react'
import { BlurFade } from '@/components/ui/BlurFade'
import { profile } from '@/data/profile'
import { formatCareerExperience } from '@/lib/experience'
import { VoiceMirrorExperience } from '@/components/ai-os/VoiceMirrorExperience'

const PROMPTS = [
  '我们公司想做 AI 应用，怎么判断有没有市场？',
  '招 AI 产品经理时，看哪些能力最关键？',
  '这个创业想法值不值得做？',
  '想从产品经理转型 AI，第一步是什么？',
]

const getStats = (experience: string, patentCount: number): Array<[string, string]> => [
  [experience, '硬科技产品经验'],
  [String(patentCount), '项专利成果'],
  ['软硬件', '研发、量产与运营经验'],
]

function useCareerExperienceLabel(): string {
  const [experience, setExperience] = useState(() => formatCareerExperience(new Date(), { includeDays: true }))

  useEffect(() => {
    const update = () => setExperience(formatCareerExperience(new Date(), { includeDays: true }))
    update()
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  return experience
}

// 实时时钟（毫秒跳动，HUD 精密感）
function useClock(): string {
  const [time, setTime] = useState('UTC+8 --:--:--.---')
  useEffect(() => {
    let raf = 0
    const pad = (n: number, l = 2) => String(n).padStart(l, '0')
    const tick = () => {
      const d = new Date()
      setTime(
        `UTC+8 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
      )
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return time
}

// 对话卡打字机轮播
function useTypewriter(prompts: string[]): string {
  const [text, setText] = useState('')
  useEffect(() => {
    let pi = 0
    let ci = 0
    let hold = 0
    let deleting = false
    let timer = 0
    const run = () => {
      const full = prompts[pi]
      if (!deleting) {
        if (ci < full.length) {
          ci++
          setText(full.slice(0, ci))
          timer = window.setTimeout(run, 42)
        } else {
          hold++
          if (hold < 70) {
            timer = window.setTimeout(run, 30)
          } else {
            deleting = true
            hold = 0
            timer = window.setTimeout(run, 30)
          }
        }
      } else if (ci > 0) {
        ci--
        setText(full.slice(0, ci))
        timer = window.setTimeout(run, 18)
      } else {
        deleting = false
        pi = (pi + 1) % prompts.length
        timer = window.setTimeout(run, 200)
      }
    }
    timer = window.setTimeout(run, 1200)
    return () => window.clearTimeout(timer)
  }, [prompts])
  return text
}

interface TickerItem {
  title: string
  source: string
  url: string
}

interface HeroProps {
  patentCount: number
  tickerItems?: TickerItem[]
}

export function Hero({ patentCount, tickerItems = [] }: HeroProps) {
  const clock = useClock()
  const typed = useTypewriter(PROMPTS)
  const experienceLabel = useCareerExperienceLabel()
  const stats = getStats(experienceLabel, patentCount)
  const [voiceOpen, setVoiceOpen] = useState(false)

  return (
    <section className="relative isolate min-h-[100svh] overflow-hidden bg-bg-primary">
      {/* 生命感背景层：纸面微噪 + 极慢漂移暖光 */}
      <svg className="hero-grain" aria-hidden width="100%" height="100%">
        <filter id="heroNoise">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.5 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#heroNoise)" />
      </svg>
      <div className="hero-glow hero-glow-1" aria-hidden />
      <div className="hero-glow hero-glow-2" aria-hidden />

      <div className="relative z-10 mx-auto flex min-h-[100svh] max-w-content flex-col px-6 pb-16 pt-28 md:px-8 lg:pt-32">
        {/* meta 行：头衔 + 实时时钟（实时信号已整合进下方滚动条）*/}
        <div className="flex items-center justify-between border-b border-border pb-6 font-mono text-[11px] uppercase tracking-[0.18em] text-text-muted">
          <span>{profile.title}</span>
          <span className="tabular-nums text-text-secondary">{clock}</span>
        </div>

        {/* 实时信号滚动条（整合原实时信号 chip）：吸引点入前沿资讯雷达 */}
        {tickerItems.length > 0 && <HeroTicker items={tickerItems} />}

        {/* 主网格：左主右辅 */}
        <div className="grid flex-1 items-center gap-12 py-10 lg:grid-cols-[1.5fr_0.88fr] lg:gap-14">
          {/* 左栏 */}
          <div>
            <h1 className="text-[clamp(80px,12vw,168px)] font-semibold leading-[0.92] tracking-[-0.02em] text-text-primary">
              {'陈川'.split('').map((ch, i) => (
                <span key={i} className="hero-char" style={{ animationDelay: `${0.18 + i * 0.13}s` }}>
                  {ch}
                </span>
              ))}
            </h1>
            <BlurFade delay={0.5}>
              <div className="mt-6 font-mono text-[clamp(12px,1.5vw,15px)] uppercase tracking-[0.2em] text-text-muted">
                {profile.nameEn} / {profile.title}
              </div>
            </BlurFade>
            <BlurFade delay={0.6}>
              <p className="mt-8 max-w-xl text-lg font-light leading-relaxed text-text-secondary md:text-xl">
                {profile.intro}
              </p>
            </BlurFade>
            <BlurFade delay={0.7}>
              <div className="mt-10 flex max-w-xl flex-wrap gap-x-12 gap-y-6 border-t border-border pt-7">
                {stats.map(([value, label]) => (
                  <div key={label}>
                    <div className="text-[clamp(26px,3vw,38px)] font-medium leading-none tracking-[-0.02em] text-text-primary [font-variant-numeric:tabular-nums]">
                      {value}
                    </div>
                    <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            </BlurFade>
            <BlurFade delay={0.85}>
              <Link
                href="/work"
                className="group mt-9 inline-flex items-center gap-2 rounded-lg bg-text-primary px-6 py-3 text-sm font-semibold text-bg-primary transition-all duration-300 hover:opacity-90"
              >
                查看代表作品
                <span className="font-mono transition group-hover:translate-x-1">→</span>
              </Link>
            </BlurFade>
          </div>

          {/* 右栏：三个 Live Demo 平级竖排（第一屏内，和左栏「陈川」同级）
              AI 镜像(紫,带打字机) / 手势(蓝) / 小可(绿)，等权不等形 */}
          <BlurFade delay={0.35}>
            <div className="flex h-full flex-col justify-center gap-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
                在线体验
              </div>
              <HeroStrategicMirrorCard typed={typed} onVoice={() => setVoiceOpen(true)} />
              <HeroDemoCard
                color="blue"
                href="/lab/ar-hud-demo"
                icon={Hand}
                name="纯 Web 手势交互"
                meta="眼动 + 手势 · 摄像头"
                desc="用摄像头试试手势控制和视线交互"
              />
              <HeroDemoCard
                color="green"
                href="/kidshub-ai/"
                external
                icon={Mic}
                name="小可 · 儿童语音 AI"
                meta="实时语音 · 表情感知"
                desc="试试小可的语音对话，了解儿童 AI 伙伴"
              />
            </div>
          </BlurFade>
        </div>
      </div>
      {voiceOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-[6vh] backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-label="陈川的 AI 战略镜像实时语音体验"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setVoiceOpen(false)
          }}
        >
          <div className="w-full max-w-4xl">
            <VoiceMirrorExperience onClose={() => setVoiceOpen(false)} />
          </div>
        </div>
      )}
    </section>
  )
}

function HeroStrategicMirrorCard({ typed, onVoice }: { typed: string; onVoice: () => void }) {
  const c = DEMO_COLOR.violet
  return (
    <div className={`group flex items-start gap-3 rounded-2xl border p-4 transition duration-300 hover:-translate-y-0.5 ${c.card}`}>
      <span className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${c.avatar}`}>
        <MessageSquare size={20} className="text-white" />
        <span className={`hero-green-dot absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full border-2 ${c.dot} bg-[#34C759]`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-text-primary">陈川的战略镜像</div>
        <div className={`mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${c.meta}`}>文字 + 实时语音 · 在线</div>
        <div className="mt-2 min-h-[2.7em] rounded-md border border-white/70 bg-white/70 px-2.5 py-1.5 text-[12px] leading-snug text-text-secondary">
          “{typed}
          <span className="hero-cursor ml-px inline-block h-[1em] w-[2px] translate-y-0.5 bg-[#6D5BD0] align-middle" />
        </div>
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={onVoice}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#6D5BD0] px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-[#5f4dc4]"
          >
            <Mic size={13} /> 开口聊 2 分钟
          </button>
          <Link
            href="/ai-os/chat"
            className="inline-flex items-center justify-center rounded-lg border border-[#6D5BD0]/25 bg-white/60 px-3 py-2 text-[11px] font-medium text-[#55459f] transition hover:border-[#6D5BD0]/50"
          >
            打字聊 →
          </Link>
        </div>
      </div>
    </div>
  )
}

type DemoColor = 'violet' | 'blue' | 'green'

const DEMO_COLOR: Record<DemoColor, { card: string; avatar: string; dot: string; meta: string }> = {
  violet: {
    card: 'border-[#6D5BD0]/30 bg-[#6D5BD0]/[0.06] hover:border-[#6D5BD0]/70 hover:shadow-[0_8px_26px_rgba(109,91,208,0.18)]',
    avatar: 'from-[#6D5BD0] to-[#8b6fe0] shadow-[0_2px_12px_rgba(109,91,208,0.35)]',
    dot: 'border-[#f1eefb]',
    meta: 'text-[#6D5BD0]',
  },
  blue: {
    card: 'border-[#0071E3]/30 bg-[#0071E3]/[0.06] hover:border-[#0071E3]/70 hover:shadow-[0_8px_26px_rgba(0,113,227,0.18)]',
    avatar: 'from-[#0071E3] to-[#4DA3F0] shadow-[0_2px_12px_rgba(0,113,227,0.35)]',
    dot: 'border-[#eaf3fd]',
    meta: 'text-[#0071E3]',
  },
  green: {
    card: 'border-[#22C55E]/30 bg-[#22C55E]/[0.06] hover:border-[#22C55E]/70 hover:shadow-[0_8px_26px_rgba(34,197,94,0.18)]',
    avatar: 'from-[#22C55E] to-[#4ADE80] shadow-[0_2px_12px_rgba(34,197,94,0.35)]',
    dot: 'border-[#eaf7ef]',
    meta: 'text-[#16A34A]',
  },
}

interface HeroDemoCardProps {
  color: DemoColor
  href: string
  icon: typeof Hand
  name: string
  meta: string
  desc?: string
  typed?: string
  external?: boolean
}

function HeroDemoCard({ color, href, icon: Icon, name, meta, desc, typed, external }: HeroDemoCardProps) {
  const c = DEMO_COLOR[color]
  const inner = (
    <>
      <span className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${c.avatar}`}>
        <Icon size={20} className="text-white" />
        <span className={`hero-green-dot absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full border-2 ${c.dot} bg-[#34C759]`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-text-primary">{name}</span>
          <span className="shrink-0 font-mono text-[13px] text-text-muted transition group-hover:translate-x-0.5 group-hover:text-text-primary">→</span>
        </div>
        <div className={`mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${c.meta}`}>{meta}</div>
        {typed !== undefined ? (
          <div className="mt-2 min-h-[2.7em] rounded-md border border-white/70 bg-white/70 px-2.5 py-1.5 text-[12px] leading-snug text-text-secondary">
            “{typed}
            <span className="hero-cursor ml-px inline-block h-[1em] w-[2px] translate-y-0.5 bg-[#6D5BD0] align-middle" />
          </div>
        ) : (
          <div className="mt-1 text-[12px] leading-snug text-text-secondary">{desc}</div>
        )}
      </div>
    </>
  )
  const cls = `group flex items-start gap-3 rounded-2xl border p-4 transition duration-300 hover:-translate-y-0.5 ${c.card}`
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  )
}

// 实时热点滚动条：整条点击进 /radar，hover 暂停可读，无缝循环
function HeroTicker({ items }: { items: TickerItem[] }) {
  const loop = [...items, ...items]
  return (
    <Link
      href="/radar"
      prefetch={false}
      aria-label="进入前沿资讯雷达"
      className="group mt-5 flex items-center gap-3 overflow-hidden rounded-full border border-border bg-bg-secondary/70 py-1.5 pl-1.5 pr-3 backdrop-blur transition-all duration-300 hover:border-border-hover hover:shadow-[0_6px_20px_rgba(0,0,0,0.05)]"
    >
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#16A34A]/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#16A34A]">
        <span className="h-[6px] w-[6px] animate-pulse rounded-full bg-[#16A34A]" />
        实时信号
      </span>
      <div className="hero-ticker-mask relative min-w-0 flex-1 overflow-hidden">
        <div className="hero-ticker-track flex w-max items-center gap-7">
          {loop.map((it, i) => (
            <span key={i} className="flex items-center gap-2">
              <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted/50" />
              <span className="whitespace-nowrap text-[13px] text-text-secondary transition-colors group-hover:text-text-primary">
                {it.title}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] text-text-muted">{it.source}</span>
            </span>
          ))}
        </div>
      </div>
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-text-muted transition group-hover:translate-x-0.5 group-hover:text-accent">
        前沿资讯雷达 →
      </span>
    </Link>
  )
}
