'use client'

import { useCallback, useMemo, useState } from 'react'

export interface ManagedVideo {
  id: string
  title: string
  description: string
  url: string
  thumbnail: string
  duration: string
  tags: string[]
  projectSlug: string | null
  published: boolean
  sort: number
  created_at: number
  updated_at: number
}

interface VideoManagerProps {
  initialVideos: ManagedVideo[]
  projects: { slug: string; title: string }[]
}

interface FormState {
  id: string
  title: string
  description: string
  url: string
  thumbnail: string
  duration: string
  tags: string // 逗号分隔输入
  projectSlug: string // '' 代表不关联（提交时转 null）
  published: boolean
  sort: number
}

const EMPTY_FORM: FormState = {
  id: '',
  title: '',
  description: '',
  url: '',
  thumbnail: '',
  duration: '',
  tags: '',
  projectSlug: '',
  published: true,
  sort: 0,
}

// tags 逗号分隔 → string[]
function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function VideoManager({ initialVideos, projects }: VideoManagerProps) {
  const [videos, setVideos] = useState<ManagedVideo[]>(initialVideos)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [isSaving, setIsSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [filterPublished, setFilterPublished] = useState<string>('all')
  const [preview, setPreview] = useState<ManagedVideo | null>(null)

  // slug → project title 查表
  const projectTitleBySlug = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of projects) m.set(p.slug, p.title)
    return m
  }, [projects])

  const filteredVideos = useMemo(() => {
    const list =
      filterPublished === 'all'
        ? videos
        : videos.filter((v) => (filterPublished === 'on' ? v.published : !v.published))
    // 按 sort 升序展示，sort 相同按更新时间倒序
    return [...list].sort((a, b) => a.sort - b.sort || b.updated_at - a.updated_at)
  }, [videos, filterPublished])

  // upsert 进本地 state（不可变）
  const upsertLocal = useCallback((video: ManagedVideo) => {
    setVideos((prev) => {
      const exists = prev.some((v) => v.id === video.id)
      return exists ? prev.map((v) => (v.id === video.id ? video : v)) : [video, ...prev]
    })
  }, [])

  const handleSave = useCallback(async () => {
    setErrorMsg(null)
    setSavedMsg(null)

    // 校验
    if (!form.id.trim()) {
      setErrorMsg('id 不能为空（例如 hud-demo-01）')
      return
    }
    if (!form.title.trim()) {
      setErrorMsg('title 不能为空')
      return
    }
    if (!form.url.trim()) {
      setErrorMsg('url 不能为空（例如 /media/xxx/clip.mp4）')
      return
    }

    setIsSaving(true)
    try {
      const res = await fetch('/api/admin/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id.trim(),
          title: form.title.trim(),
          description: form.description.trim(),
          url: form.url.trim(),
          thumbnail: form.thumbnail.trim(),
          duration: form.duration.trim(),
          tags: parseTags(form.tags),
          projectSlug: form.projectSlug === '' ? null : form.projectSlug,
          published: form.published,
          sort: form.sort,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setErrorMsg(`保存失败：${body.error ?? res.status}`)
        return
      }
      const data = (await res.json()) as { video: ManagedVideo }
      upsertLocal(data.video)
      setSavedMsg(`已保存 ${data.video.id}`)
      setForm(EMPTY_FORM)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '网络错误')
    } finally {
      setIsSaving(false)
    }
  }, [form, upsertLocal])

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm(`确认删除视频 "${id}"？此操作不可撤销（硬删除）。`)) return
    try {
      const res = await fetch(`/api/admin/videos?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setErrorMsg(`删除失败：${body.error ?? res.status}`)
        return
      }
      setVideos((prev) => prev.filter((v) => v.id !== id))
      setSavedMsg(`已删除 ${id}`)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '网络错误')
    }
  }, [])

  // 快捷上架/下架：仅改 published，复用 POST upsert
  const handleTogglePublished = useCallback(
    async (video: ManagedVideo) => {
      setErrorMsg(null)
      try {
        const res = await fetch('/api/admin/videos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: video.id,
            title: video.title,
            description: video.description,
            url: video.url,
            thumbnail: video.thumbnail,
            duration: video.duration,
            tags: video.tags,
            projectSlug: video.projectSlug,
            published: !video.published,
            sort: video.sort,
          }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setErrorMsg(`状态切换失败：${body.error ?? res.status}`)
          return
        }
        const data = (await res.json()) as { video: ManagedVideo }
        upsertLocal(data.video)
        setSavedMsg(`已${data.video.published ? '上架' : '下架'} ${data.video.id}`)
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '网络错误')
      }
    },
    [upsertLocal],
  )

  const handleLoadIntoForm = useCallback((video: ManagedVideo) => {
    setForm({
      id: video.id,
      title: video.title,
      description: video.description,
      url: video.url,
      thumbnail: video.thumbnail,
      duration: video.duration,
      tags: video.tags.join(', '),
      projectSlug: video.projectSlug ?? '',
      published: video.published,
      sort: video.sort,
    })
    setSavedMsg(null)
    setErrorMsg(null)
    document.getElementById('video-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div className="space-y-8">
      {/* 添加 / 编辑表单 */}
      <section id="video-form" className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-[0.18em] text-[#7FE5FF]/85">
          添加 / 更新视频（已存在 id 会被覆盖）
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="id（唯一，如 hud-demo-01）">
            <input
              type="text"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="hud-demo-01"
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
            />
          </FormField>

          <FormField label="关联项目（可选）">
            <select
              value={form.projectSlug}
              onChange={(e) => setForm({ ...form, projectSlug: e.target.value })}
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white focus:border-[#7FE5FF]/60 focus:outline-none"
            >
              <option value="">（不关联）</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField label="title（标题）">
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="全车窗 HUD 概念车实拍"
            className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 text-[13px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
          />
        </FormField>

        <FormField label="description（描述）">
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            placeholder="一句话介绍这段视频的内容"
            className="w-full resize-y rounded border border-white/15 bg-black/40 px-3 py-2 text-[13px] leading-relaxed text-white/85 placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
          />
        </FormField>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="url（视频路径，如 /media/xxx/clip.mp4）">
            <input
              type="text"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="/media/futurus-hud/full-window-hud-live.mp4"
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
            />
          </FormField>

          <FormField label="thumbnail（缩略图路径，可选）">
            <input
              type="text"
              value={form.thumbnail}
              onChange={(e) => setForm({ ...form, thumbnail: e.target.value })}
              placeholder="/media/xxx/poster.jpg"
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
            />
          </FormField>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="duration（时长，如 1:09）">
            <input
              type="text"
              value={form.duration}
              onChange={(e) => setForm({ ...form, duration: e.target.value })}
              placeholder="1:09"
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
            />
          </FormField>

          <FormField label="tags（逗号分隔，如 HUD, 座舱, AR）">
            <input
              type="text"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="HUD, 座舱, AR"
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 text-[13px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
            />
          </FormField>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-4 text-[12px]">
          <label className="flex items-center gap-2 text-white/80">
            <input
              type="checkbox"
              checked={form.published}
              onChange={(e) => setForm({ ...form, published: e.target.checked })}
            />
            published（上架；取消勾选为下架）
          </label>
          <label className="flex items-center gap-2 text-white/80">
            sort（排序，越小越靠前）:
            <input
              type="number"
              value={form.sort}
              onChange={(e) =>
                setForm({ ...form, sort: Number.parseInt(e.target.value, 10) || 0 })
              }
              className="w-20 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono tabular-nums text-white focus:border-[#7FE5FF]/60 focus:outline-none"
            />
          </label>
        </div>

        {savedMsg && (
          <div className="mb-3 rounded border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[12px] text-emerald-200">
            ✓ {savedMsg}
          </div>
        )}
        {errorMsg && (
          <div className="mb-3 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-[12px] text-red-200">
            ✗ {errorMsg}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="rounded border border-[#7FE5FF]/55 bg-[#7FE5FF]/[0.08] px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-[#7FE5FF] transition hover:bg-[#7FE5FF]/[0.16] disabled:opacity-40"
          >
            {isSaving ? '保存中...' : '保存'}
          </button>
          <button
            type="button"
            onClick={() => {
              setForm(EMPTY_FORM)
              setSavedMsg(null)
              setErrorMsg(null)
            }}
            className="rounded border border-white/15 bg-black/40 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white/70 transition hover:border-white/30 hover:text-white"
          >
            重置
          </button>
        </div>
      </section>

      {/* 列表 */}
      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-[#7FE5FF]/85">
            已有视频 · {videos.length} 条
          </h2>
          <select
            value={filterPublished}
            onChange={(e) => setFilterPublished(e.target.value)}
            className="rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] text-white/80 focus:border-[#7FE5FF]/60 focus:outline-none"
          >
            <option value="all">全部状态</option>
            <option value="on">仅上架</option>
            <option value="off">仅下架</option>
          </select>
        </div>

        {filteredVideos.length === 0 ? (
          <p className="py-6 text-center text-sm text-white/40">该筛选下暂无视频</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-white/45">
                  <th className="pb-2 pr-3 font-mono">sort</th>
                  <th className="pb-2 pr-3 font-mono">标题</th>
                  <th className="pb-2 pr-3 font-mono">关联项目</th>
                  <th className="pb-2 pr-3 font-mono">时长</th>
                  <th className="pb-2 pr-3 font-mono">状态</th>
                  <th className="pb-2 font-mono">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredVideos.map((v) => (
                  <tr key={v.id} className="border-b border-white/[0.04] text-white/80">
                    <td className="py-2 pr-3 font-mono tabular-nums text-white/65">{v.sort}</td>
                    <td className="max-w-[320px] py-2 pr-3">
                      <button
                        type="button"
                        onClick={() => setPreview(v)}
                        className="block max-w-full truncate text-left text-[#7FE5FF]/85 hover:text-[#7FE5FF] hover:underline"
                        title={`${v.title}（点击预览）`}
                      >
                        {v.title}
                      </button>
                      <span className="block truncate font-mono text-[10px] text-white/40" title={v.id}>
                        {v.id}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate py-2 pr-3 text-white/65" title={v.projectSlug ?? ''}>
                      {v.projectSlug
                        ? projectTitleBySlug.get(v.projectSlug) ?? `（未知 ${v.projectSlug}）`
                        : '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-white/65">{v.duration || '—'}</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">
                      {v.published ? (
                        <span className="text-emerald-300/85">🟢 上架</span>
                      ) : (
                        <span className="text-white/45">⚪ 下架</span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-[11px]">
                      <button
                        type="button"
                        onClick={() => handleLoadIntoForm(v)}
                        className="mr-2 text-[#7FE5FF]/80 hover:text-[#7FE5FF] hover:underline"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleTogglePublished(v)}
                        className="mr-2 text-amber-200/80 hover:text-amber-100 hover:underline"
                      >
                        {v.published ? '下架' : '上架'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(v.id)}
                        className="text-red-300/80 hover:text-red-200 hover:underline"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 预览弹层 */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreview(null)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-white/15 bg-black/90 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-white">{preview.title}</h3>
                <p className="mt-0.5 font-mono text-[11px] text-white/45">{preview.url}</p>
              </div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/60 transition hover:border-white/30 hover:text-white"
              >
                关闭
              </button>
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={preview.url}
              poster={preview.thumbnail || undefined}
              controls
              className="aspect-video w-full rounded border border-white/10 bg-black"
            />
            {preview.description && (
              <p className="mt-3 text-[13px] leading-relaxed text-white/75">{preview.description}</p>
            )}
            {preview.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {preview.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded border border-white/15 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-white/60"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <a
              href={preview.url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block font-mono text-[11px] text-[#7FE5FF]/80 hover:text-[#7FE5FF] hover:underline"
            >
              新标签页打开 →
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        {label}
      </label>
      {children}
    </div>
  )
}
