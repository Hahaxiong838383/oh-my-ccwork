import type { Metadata } from 'next'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { Tag } from '@/components/shared/Tag'
import { getVideos } from '@/lib/data'
import { Play } from 'lucide-react'

export const metadata: Metadata = { title: '视频' }
export const revalidate = 60

export default async function VideosPage() {
  const videos = await getVideos()

  const hasRealVideo = (url: string) => url && url !== '#'

  return (
    <div className="pt-24">
      <SectionWrapper>
        <SectionTitle label="Video Library" title="视频库" />
        <p className="mb-12 max-w-2xl text-text-secondary">
          产品演示、路测实录与工作流分享。部分视频待上传，可联系获取。
        </p>

        <div className="grid gap-6 md:grid-cols-2">
          {videos.map((video, i) => (
            <BlurFade key={video.title} delay={i * 0.08}>
              <div className="group overflow-hidden rounded-xl border border-white/[0.06] bg-bg-card transition-all hover:border-white/[0.1]">
                <div className="relative aspect-video bg-gradient-to-br from-bg-secondary to-bg-card">
                  {hasRealVideo(video.url) ? (
                    <video
                      src={video.url}
                      controls
                      preload={i < 4 ? 'metadata' : 'none'}
                      poster={video.thumbnail || undefined}
                      playsInline
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.05]">
                        <Play size={22} className="ml-0.5 text-text-secondary" />
                      </div>
                    </div>
                  )}
                  <span className="absolute bottom-3 right-3 rounded bg-black/60 px-2 py-0.5 font-mono text-xs text-text-secondary">
                    {video.duration}
                  </span>
                </div>
                <div className="p-5">
                  <h3 className="mb-2 text-base font-medium text-text-primary">{video.title}</h3>
                  <p className="mb-2 text-sm leading-relaxed text-text-secondary">{video.description}</p>
                  {video.projectTitle && video.projectSlug && (
                    <a
                      href={`/work/${video.projectSlug}`}
                      className="mb-3 inline-flex items-center gap-1 text-xs text-accent transition hover:underline"
                    >
                      关联项目 · {video.projectTitle}
                    </a>
                  )}
                  <div className="flex gap-1.5">
                    {video.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </div>
                </div>
              </div>
            </BlurFade>
          ))}
        </div>
      </SectionWrapper>
    </div>
  )
}
