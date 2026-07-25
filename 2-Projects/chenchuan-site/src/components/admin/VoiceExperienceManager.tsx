'use client'

import { useCallback, useEffect, useState } from 'react'

interface CodeItem {
  codeHint: string
  label: string | null
  maxUses: number
  usedCount: number
  expiresAt: number
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export function VoiceExperienceManager() {
  const [items, setItems] = useState<CodeItem[]>([])
  const [label, setLabel] = useState('访客追加体验')
  const [validDays, setValidDays] = useState(7)
  const [maxUses, setMaxUses] = useState(1)
  const [visitorId, setVisitorId] = useState('')
  const [freshCode, setFreshCode] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/voice-experience', { cache: 'no-store' })
    if (response.ok) setItems(((await response.json()) as { items: CodeItem[] }).items)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const generate = async () => {
    setFreshCode(null)
    const response = await fetch('/api/admin/voice-experience', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, valid_days: validDays, max_uses: maxUses }),
    })
    const data = (await response.json()) as { item?: CodeItem & { code: string }; error?: string }
    if (!response.ok || !data.item) {
      setMessage(data.error ?? '生成失败')
      return
    }
    setFreshCode(data.item.code)
    setMessage('体验码已生成。明文只在这里显示一次。')
    await load()
  }

  const reset = async () => {
    const response = await fetch('/api/admin/voice-experience', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitorId.trim().toUpperCase() }),
    })
    const data = (await response.json()) as { reset?: boolean; error?: string }
    setMessage(response.ok ? (data.reset ? '该访客今天的基础体验已重置。' : '编号有效，但今天没有可重置记录。') : data.error ?? '重置失败')
  }

  const revoke = async (codeHint: string) => {
    await fetch(`/api/admin/voice-experience?code_hint=${encodeURIComponent(codeHint)}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#B8ADFF]">Generate Pass</div>
        <h2 className="mt-1 text-lg font-semibold text-white">生成追加 2 分钟体验码</h2>
        <p className="mt-1 text-xs leading-relaxed text-white/45">访客联系你后，把体验码发给对方。系统只保存哈希，明文只展示一次。</p>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_120px_120px_auto]">
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="备注" className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white outline-none focus:border-[#8F7CFF]" />
          <label className="text-[10px] text-white/45">有效天数<input type="number" min={1} max={30} value={validDays} onChange={(event) => setValidDays(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white outline-none" /></label>
          <label className="text-[10px] text-white/45">可用次数<input type="number" min={1} max={50} value={maxUses} onChange={(event) => setMaxUses(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white outline-none" /></label>
          <button type="button" onClick={() => void generate()} className="self-end rounded-lg bg-[#725EFF] px-4 py-2 text-sm font-semibold text-white hover:brightness-110">生成体验码</button>
        </div>
        {freshCode && (
          <div className="mt-4 rounded-lg border border-emerald-300/25 bg-emerald-300/10 p-4">
            <div className="text-[11px] text-emerald-100/70">仅显示一次</div>
            <div className="mt-1 break-all font-mono text-lg tracking-[0.1em] text-emerald-100">{freshCode}</div>
            <button type="button" onClick={() => void navigator.clipboard.writeText(freshCode)} className="mt-2 text-xs text-emerald-200 underline underline-offset-2">复制体验码</button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#7FE5FF]">Reset Visitor</div>
        <h2 className="mt-1 text-lg font-semibold text-white">重置访客今日基础体验</h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input value={visitorId} onChange={(event) => setVisitorId(event.target.value.toUpperCase())} placeholder="V-XXXXXXXXXX" className="flex-1 rounded-lg border border-white/10 bg-black/25 px-3 py-2 font-mono text-sm uppercase text-white outline-none focus:border-[#7FE5FF]" />
          <button type="button" onClick={() => void reset()} className="rounded-lg border border-[#7FE5FF]/35 px-4 py-2 text-sm text-[#7FE5FF] hover:bg-[#7FE5FF]/10">重置一次</button>
        </div>
        {message && <div className="mt-3 text-xs text-white/55">{message}</div>}
      </section>

      <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
        <div className="border-b border-white/10 px-5 py-4"><h2 className="text-sm font-semibold text-white">体验码记录</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-white/35"><tr><th className="px-5 py-3">掩码</th><th>备注</th><th>使用</th><th>到期</th><th>状态</th><th /></tr></thead>
            <tbody>
              {items.map((item) => {
                const expired = item.expiresAt <= Date.now()
                const status = item.revokedAt ? '已撤销' : expired ? '已过期' : item.usedCount >= item.maxUses ? '已用完' : '可用'
                return <tr key={`${item.codeHint}-${item.createdAt}`} className="border-t border-white/[0.06] text-white/65"><td className="px-5 py-3 font-mono text-white">{item.codeHint}</td><td>{item.label ?? '—'}</td><td>{item.usedCount} / {item.maxUses}</td><td>{new Date(item.expiresAt).toLocaleString('zh-CN')}</td><td>{status}</td><td className="pr-5 text-right">{!item.revokedAt && !expired && <button type="button" onClick={() => void revoke(item.codeHint)} className="text-rose-300 hover:text-rose-200">撤销</button>}</td></tr>
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
