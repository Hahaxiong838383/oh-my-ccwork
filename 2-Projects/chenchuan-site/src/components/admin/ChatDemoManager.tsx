'use client'

import { useCallback, useState } from 'react'
import type { ClassicDemo } from '@/lib/chat/demos'

interface ChatDemoManagerProps {
  initialDemos: ClassicDemo[]
}

interface FormState {
  id: string
  category: string
  question: string
  featured: boolean
  quality_score: number
  routing_json: string // JSON 字符串
}

const EMPTY_FORM: FormState = {
  id: '',
  category: 'arch',
  question: '',
  featured: false,
  quality_score: 70,
  routing_json:
    '[\n  {\n    "engine": "cc",\n    "stage": "业务逻辑定义",\n    "duration_ms": 600000,\n    "output_md": "..."\n  }\n]',
}

export function ChatDemoManager({ initialDemos }: ChatDemoManagerProps) {
  const [demos, setDemos] = useState<ClassicDemo[]>(initialDemos)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [isSaving, setIsSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [filterCategory, setFilterCategory] = useState<string>('all')

  const filteredDemos = filterCategory === 'all' ? demos : demos.filter((d) => d.category === filterCategory)

  const handleSave = useCallback(async () => {
    setErrorMsg(null)
    setSavedMsg(null)

    // 校验
    if (!form.id.trim()) {
      setErrorMsg('id 不能为空（例如 arch-02）')
      return
    }
    if (!form.question.trim()) {
      setErrorMsg('question 不能为空')
      return
    }
    let routing: unknown
    try {
      routing = JSON.parse(form.routing_json)
    } catch {
      setErrorMsg('routing_json 不是合法 JSON')
      return
    }
    if (!Array.isArray(routing) || routing.length === 0) {
      setErrorMsg('routing 必须是非空数组')
      return
    }

    setIsSaving(true)
    try {
      const res = await fetch('/api/admin/chat/demos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id.trim(),
          category: form.category,
          question: form.question.trim(),
          routing,
          featured: form.featured,
          quality_score: form.quality_score,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setErrorMsg(`保存失败：${body.error ?? res.status}`)
        return
      }
      const data = (await res.json()) as { demo: ClassicDemo }
      // 上插或替换
      setDemos((prev) => {
        const exists = prev.some((d) => d.id === data.demo.id)
        return exists ? prev.map((d) => (d.id === data.demo.id ? data.demo : d)) : [data.demo, ...prev]
      })
      setSavedMsg(`已保存 ${data.demo.id}`)
      setForm(EMPTY_FORM)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '网络错误')
    } finally {
      setIsSaving(false)
    }
  }, [form])

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm(`确认删除 demo "${id}"？此操作不可撤销。`)) return
    try {
      const res = await fetch(`/api/admin/chat/demos?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setErrorMsg(`删除失败：${body.error ?? res.status}`)
        return
      }
      setDemos((prev) => prev.filter((d) => d.id !== id))
      setSavedMsg(`已删除 ${id}`)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '网络错误')
    }
  }, [])

  const handleLoadIntoForm = useCallback((demo: ClassicDemo) => {
    setForm({
      id: demo.id,
      category: demo.category,
      question: demo.question,
      featured: demo.featured,
      quality_score: demo.quality_score,
      routing_json: JSON.stringify(demo.routing, null, 2),
    })
    setSavedMsg(null)
    setErrorMsg(null)
    document.getElementById('demo-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div className="space-y-8">
      {/* 提示 */}
      <div className="rounded border border-amber-300/30 bg-amber-300/[0.06] p-3 text-[12px] text-amber-100/85">
        <strong className="text-amber-200">⚠ 注意</strong>：admin 写入的 demo 进入 SQLite classic_demos 表。
        SSR 加载的代码里有静态 5 条（src/data/classic-demos.ts），admin 写入的数据**目前不自动合并**到前端 demo 列表。
        如需让 admin 数据出现在 /ai-os/chat，需要后续把 page.tsx 改成 fetch 数据库 demo（P5 优化）。
      </div>

      {/* 添加 / 编辑表单 */}
      <section id="demo-form" className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-[0.18em] text-[#7FE5FF]/85">
          添加 / 更新 Demo（已存在 id 会被覆盖）
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="id（唯一，如 arch-02）">
            <input
              type="text"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="speed-03"
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
            />
          </FormField>

          <FormField label="category">
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white focus:border-[#7FE5FF]/60 focus:outline-none"
            >
              <option value="arch">arch 架构冲突</option>
              <option value="speed">speed 极速交付</option>
              <option value="cognition">cognition 认知沉淀</option>
              <option value="failure">failure 失败诊断</option>
              <option value="crossover">crossover 跨界范式</option>
            </select>
          </FormField>
        </div>

        <FormField label="question（访客点击的 chip 文案）">
          <input
            type="text"
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
            placeholder="问问陈川对 X 的看法"
            className="w-full rounded border border-white/15 bg-black/40 px-3 py-1.5 text-[13px] text-white placeholder:text-white/30 focus:border-[#7FE5FF]/60 focus:outline-none"
          />
        </FormField>

        <FormField label="routing JSON（数组，每条含 engine/stage/duration_ms/output_md）">
          <textarea
            value={form.routing_json}
            onChange={(e) => setForm({ ...form, routing_json: e.target.value })}
            rows={14}
            className="w-full resize-y rounded border border-white/15 bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-white/85 focus:border-[#7FE5FF]/60 focus:outline-none"
          />
        </FormField>

        <div className="mb-4 flex items-center gap-4 text-[12px]">
          <label className="flex items-center gap-2 text-white/80">
            <input
              type="checkbox"
              checked={form.featured}
              onChange={(e) => setForm({ ...form, featured: e.target.checked })}
            />
            featured（前端置顶显示）
          </label>
          <label className="flex items-center gap-2 text-white/80">
            quality_score:
            <input
              type="number"
              min={0}
              max={100}
              value={form.quality_score}
              onChange={(e) =>
                setForm({ ...form, quality_score: Number.parseInt(e.target.value, 10) || 0 })
              }
              className="w-16 rounded border border-white/15 bg-black/40 px-2 py-1 font-mono tabular-nums text-white focus:border-[#7FE5FF]/60 focus:outline-none"
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
            已有 Demo · {demos.length} 条
          </h2>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="rounded border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] text-white/80 focus:border-[#7FE5FF]/60 focus:outline-none"
          >
            <option value="all">所有 category</option>
            <option value="arch">arch 架构冲突</option>
            <option value="speed">speed 极速交付</option>
            <option value="cognition">cognition 认知沉淀</option>
            <option value="failure">failure 失败诊断</option>
            <option value="crossover">crossover 跨界范式</option>
          </select>
        </div>

        {filteredDemos.length === 0 ? (
          <p className="py-6 text-center text-sm text-white/40">该 category 下暂无 demo</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-white/45">
                  <th className="pb-2 pr-3 font-mono">id</th>
                  <th className="pb-2 pr-3 font-mono">category</th>
                  <th className="pb-2 pr-3 font-mono">question</th>
                  <th className="pb-2 pr-3 font-mono">⭐</th>
                  <th className="pb-2 pr-3 font-mono">score</th>
                  <th className="pb-2 font-mono">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredDemos.map((d) => (
                  <tr key={d.id} className="border-b border-white/[0.04] text-white/80">
                    <td className="py-2 pr-3 font-mono text-[11px] text-[#7FE5FF]/85">{d.id}</td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-white/65">{d.category}</td>
                    <td className="max-w-[420px] truncate py-2 pr-3" title={d.question}>
                      {d.question}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-white/65">
                      {d.featured ? '✓' : ''}
                    </td>
                    <td className="py-2 pr-3 font-mono tabular-nums text-white/65">{d.quality_score}</td>
                    <td className="py-2 font-mono text-[11px]">
                      <button
                        type="button"
                        onClick={() => handleLoadIntoForm(d)}
                        className="mr-2 text-[#7FE5FF]/80 hover:text-[#7FE5FF] hover:underline"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(d.id)}
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
