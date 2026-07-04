'use client'

import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { MagicCard } from '@/components/ui/MagicCard'
import { Tag } from '@/components/shared/Tag'
import type { Video } from '@/data/videos'
import { Play } from 'lucide-react'

interface Props {
  videos: Video[]
}

export function VideoSection({ videos }: Props) {
  const hasRealVideo = (url: string) => url && url !== '#'

  return (
    <SectionWrapper id="videos">
      <SectionTitle label="视频演示" title="原型与现场" />
      <div className="gap-5 space-y-5 md:columns-2">
        {videos.map((video, i) => (
          <div key={video.title} className="mb-5 break-inside-avoid">
          <BlurFade delay={i * 0.08}>
            <MagicCard
              className="video-card group"
              gradientColor="rgba(34, 197, 94, 0.1)"
            >
              {/* Video area — 按原视频比例显示，不裁切 */}
              <div className="relative bg-gradient-to-br from-bg-secondary to-bg-card">
                {hasRealVideo(video.url) ? (
                  <video
                    src={video.url}
                    controls
                    preload={i < 2 ? 'metadata' : 'none'}
                    poster={video.thumbnail || undefined}
                    playsInline
                    className="block h-auto w-full"
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-bg-secondary">
                      <Play size={18} className="ml-0.5 text-text-secondary" />
                    </div>
                  </div>
                )}
                <span className="absolute bottom-3 right-3 rounded bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white">
                  {video.duration}
                </span>
              </div>

              {/* Info */}
              <div className="p-4">
                <h3 className="mb-1 text-sm font-medium text-text-primary">{video.title}</h3>
                <p className="mb-2 text-xs leading-relaxed text-text-muted">{video.description}</p>
                {video.projectTitle && video.projectSlug && (
                  <a
                    href={`/work/${video.projectSlug}`}
                    className="mb-3 inline-flex items-center gap-1 text-[11px] text-accent transition hover:underline"
                  >
                    关联项目 · {video.projectTitle}
                  </a>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {video.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </div>
              </div>
            </MagicCard>
          </BlurFade>
          </div>
        ))}
      </div>
    </SectionWrapper>
  )
}
