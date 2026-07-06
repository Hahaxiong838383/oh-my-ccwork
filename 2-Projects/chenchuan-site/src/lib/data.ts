import { directus, readItems, readSingleton } from './directus'
import type { DProfile, DProject, DPatent, DTimeline, DArticle } from './directus'

// Local fallback data
import { profile as localProfile } from '@/data/profile'
import { projects as localProjects } from '@/data/projects'
import { patents as localPatents } from '@/data/patents'
import { timeline as localTimeline } from '@/data/timeline'
import { articles as localArticles } from '@/data/articles'
import { videos as localVideos } from '@/data/videos'

// Helper: try CMS first, fallback to local
async function tryFetch<T>(fetcher: () => Promise<T>, fallback: T): Promise<T> {
  try {
    const result = await fetcher()
    // If result is empty array, use fallback
    if (Array.isArray(result) && result.length === 0) return fallback
    return result
  } catch {
    return fallback
  }
}

// ── Profile ──
function mapProfile(d: DProfile) {
  return {
    ...localProfile,
    name: d.name,
    nameEn: d.name_en,
    title: d.title,
    tagline: d.tagline,
    bio: d.bio,
    bioExtended: d.bio_extended,
    contact: {
      ...localProfile.contact,
      phone: d.phone,
      email: d.email,
      location: d.location,
      linkedin: d.linkedin,
      github: d.github,
      wechat: d.wechat,
    },
  }
}

export async function getProfile() {
  return tryFetch(
    async () => {
      const d = await directus.request(readSingleton('profile'))
      return mapProfile(d)
    },
    localProfile,
  )
}

// ── Projects ──
// Internal URL for server-side API calls
const DIRECTUS_URL_INTERNAL = process.env.DIRECTUS_URL || 'http://localhost:8055'
// Public URL for asset links in rendered HTML
const CMS_URL = process.env.DIRECTUS_PUBLIC_URL || DIRECTUS_URL_INTERNAL

// Map CMS project_videos relation to video array
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapCmsVideos(projectVideos: any[]): { title: string; url: string; duration: string }[] {
  if (!projectVideos || !Array.isArray(projectVideos)) return []
  return projectVideos.map((pv) => ({
    title: String(pv.title || ''),
    url: pv.video_file ? `${CMS_URL}/assets/${pv.video_file}` : '#',
    duration: String(pv.duration || ''),
  }))
}

function mapProject(d: DProject, cmsVideos?: unknown[]) {
  const videos = cmsVideos && cmsVideos.length > 0
    ? mapCmsVideos(cmsVideos)
    : undefined
  return {
    slug: d.slug,
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    fullDescription: d.full_description,
    tags: d.tags || [],
    year: d.year,
    company: d.company,
    role: d.role,
    highlights: d.highlights || [],
    wins: d.wins || [],
    color: d.color,
    featured: d.featured,
    videos: videos as undefined | { title: string; url: string; duration: string }[],
    images: undefined as undefined | string[],
    relatedSlugs: undefined as undefined | string[],
  }
}

export async function getProjects() {
  let cmsProjects: ReturnType<typeof mapProject>[] = []
  try {
    const items = await directus.request(
      readItems('projects', {
        filter: { status: { _eq: 'published' } },
        sort: ['sort'],
        limit: -1,
        // @ts-expect-error - deep relation fields
        fields: ['*', 'project_videos.*'],
      }),
    )
    cmsProjects = items.map((item) => {
      const pvs = (item as Record<string, unknown>).project_videos as unknown[] | undefined
      return mapProject(item, pvs)
    })
  } catch { /* CMS unavailable, use all local */ }

  if (cmsProjects.length === 0) return localProjects

  // Merge: CMS projects + local-only projects (not in CMS)
  const cmsSlugs = new Set(cmsProjects.map((p) => p.slug))
  const localOnly = localProjects.filter((p) => !cmsSlugs.has(p.slug))

  // For CMS projects, merge local videos/images/relatedSlugs
  const merged = cmsProjects.map((cms) => {
    const local = localProjects.find((p) => p.slug === cms.slug)
    if (!local) return cms
    return {
      ...cms,
      videos: (local.videos && local.videos.length > 0) ? local.videos : cms.videos,
      images: local.images ?? cms.images,
      relatedSlugs: local.relatedSlugs ?? cms.relatedSlugs,
    }
  })

  return [...merged, ...localOnly]
}

export async function getProjectBySlug(slug: string) {
  const local = localProjects.find((p) => p.slug === slug)
  let cms = null
  try {
    const items = await directus.request(
      readItems('projects', {
        filter: { slug: { _eq: slug }, status: { _eq: 'published' } },
        limit: 1,
        // @ts-expect-error - deep relation fields
        fields: ['*', 'project_videos.*'],
      }),
    )
    if (items.length > 0) {
      const pvs = (items[0] as Record<string, unknown>).project_videos as unknown[] | undefined
      cms = mapProject(items[0], pvs)
    }
  } catch { /* fallback */ }

  if (!local && !cms) return null
  if (!cms) return local!
  if (!local) return cms

  // Merge: local videos (static paths) preferred over CMS (Directus asset URLs)
  // CMS manages the association, but actual playback uses local media files
  return {
    ...cms,
    videos: (local.videos && local.videos.length > 0) ? local.videos : cms.videos,
    images: local.images ?? cms.images,
    relatedSlugs: local.relatedSlugs ?? cms.relatedSlugs,
  }
}

// ── Patents ──
function mapPatent(d: DPatent) {
  return {
    title: d.title,
    number: d.number,
    status: d.status as '发明' | '发明授权' | '实用新型',
    statusLabel: d.status_label,
  }
}

export async function getPatents() {
  return tryFetch(
    async () => {
      const items = await directus.request(
        readItems('patents', { sort: ['sort'], limit: -1 }),
      )
      return items.map(mapPatent)
    },
    localPatents,
  )
}

// ── Timeline ──
function mapTimeline(d: DTimeline) {
  return {
    period: d.period,
    company: d.company,
    role: d.role,
    description: d.description,
    tags: d.tags || [],
  }
}

export async function getTimeline() {
  return tryFetch(
    async () => {
      const items = await directus.request(
        readItems('timeline', { sort: ['sort'], limit: -1 }),
      )
      return items.map(mapTimeline)
    },
    localTimeline,
  )
}

// ── Articles ──
function mapArticle(d: DArticle) {
  return {
    slug: d.slug,
    title: d.title,
    excerpt: d.excerpt,
    date: d.date,
    tags: d.tags || [],
    content: d.content,
  }
}

export async function getArticles() {
  return tryFetch(
    async () => {
      const items = await directus.request(
        readItems('articles', {
          filter: { status: { _eq: 'published' } },
          sort: ['-date'],
          limit: -1,
        }),
      )
      return items.map(mapArticle)
    },
    localArticles,
  )
}

export async function getArticleBySlug(slug: string) {
  try {
    const items = await directus.request(
      readItems('articles', {
        filter: { slug: { _eq: slug }, status: { _eq: 'published' } },
        limit: 1,
      }),
    )
    if (items.length > 0) return mapArticle(items[0])
  } catch { /* fallback */ }
  return localArticles.find((a) => a.slug === slug) ?? null
}

// ── Videos ──
// 视频库真相源 = admin 管理的 SQLite（managed_videos，published=1）。
// 表为空/读取异常 → 回退本地静态 videos.ts（页面永不空）。Directus 已弃用，不再读。
function getOptimizedVideoUrl(url: string): string {
  if (!url.startsWith('/media/') || !url.endsWith('.mp4')) return url
  return url.replace('/media/', '/media-optimized/')
}

function getOptimizedVideoPoster(url: string, thumbnail: string): string {
  if (thumbnail) return thumbnail
  const optimizedUrl = getOptimizedVideoUrl(url)
  if (!optimizedUrl.startsWith('/media-optimized/') || !optimizedUrl.endsWith('.mp4')) return ''
  return optimizedUrl.replace('/media-optimized/', '/media-posters/').replace(/\.mp4$/, '.jpg')
}

export async function getVideos() {
  try {
    const { listPublishedVideos, countManagedVideos } = await import('@/lib/videos/store')
    if (countManagedVideos() > 0) {
      return listPublishedVideos().map((v) => {
        const proj = v.projectSlug ? localProjects.find((p) => p.slug === v.projectSlug) : null
        return {
          title: v.title,
          description: v.description,
          url: getOptimizedVideoUrl(v.url),
          thumbnail: getOptimizedVideoPoster(v.url, v.thumbnail),
          duration: v.duration,
          tags: v.tags,
          projectSlug: v.projectSlug ?? undefined,
          projectTitle: proj?.title,
        }
      })
    }
  } catch {
    // SQLite 不可用（如构建期无 DB）→ 回退本地
  }
  return localVideos
}
