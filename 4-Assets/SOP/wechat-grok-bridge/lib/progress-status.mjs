/**
 * WeChat-only progress feedback for long-running grok tasks.
 * 文案前缀【进度】；可 WX_STATUS=0 关闭。
 */

function envFlag(name, def = false) {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  return /^(1|true|yes|on)$/i.test(v)
}

export function wxStatusEnabled() {
  return envFlag('WX_STATUS', true)
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

/**
 * @param {{
 *   sendText: (text: string) => Promise<void>,
 *   log?: (...args: any[]) => void,
 * }} opts
 */
export function createProgressReporter(opts) {
  const sendText = opts.sendText
  const log = opts.log || (() => {})

  if (!wxStatusEnabled()) {
    return {
      enabled: false,
      setMeta() {},
      noteActivity() {},
      async queue() {},
      async start() {},
      async continueRound() {},
      async interrupted() {},
      stop() {},
    }
  }

  const firstMs = Math.max(
    0,
    Number(process.env.WX_STATUS_FIRST_SEC ?? 60) * 1000,
  )
  const beatMs = Math.max(
    0,
    Number(process.env.WX_STATUS_HEARTBEAT_SEC ?? 120) * 1000,
  )
  const maxBeats = Math.max(0, Number(process.env.WX_STATUS_MAX_BEATS ?? 8))
  const sparseMs = Math.max(
    beatMs,
    Number(process.env.WX_STATUS_SPARSE_SEC ?? 300) * 1000,
  )
  const idleWarnMs = Math.max(
    60_000,
    Number(process.env.WX_STATUS_IDLE_WARN_SEC ?? 180) * 1000,
  )

  let startedAt = Date.now()
  let lastActivity = Date.now()
  let beatCount = 0
  let timer = null
  let stopped = false
  let meta = { mode: 'full', turns: '?', sid: '?' }

  async function push(body) {
    if (stopped) return
    const text = `【进度】${body}`
    try {
      await sendText(text)
    } catch (e) {
      log('status send fail', String(e?.message || e).slice(0, 120))
    }
  }

  function schedule(delay) {
    if (stopped || beatMs <= 0) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void tick()
    }, delay)
  }

  async function tick() {
    if (stopped) return
    beatCount += 1
    const elapsed = formatElapsed(Date.now() - startedAt)
    const idle = Date.now() - lastActivity
    const activity = idle >= idleWarnMs ? '等待工具/模型' : '正常'
    await push(`仍在执行 · 已 ${elapsed} · ${activity}`)
    const next = beatCount >= maxBeats ? sparseMs : beatMs
    schedule(next)
  }

  return {
    enabled: true,
    setMeta(m) {
      meta = { ...meta, ...m }
    },
    noteActivity() {
      lastActivity = Date.now()
    },
    async queue(ahead) {
      const n = Number(ahead) || 0
      if (n > 0) await push(`排队中 · 前面还有 ${n} 个任务`)
    },
    async start() {
      startedAt = Date.now()
      lastActivity = Date.now()
      beatCount = 0
      const sid = String(meta.sid || '?').slice(0, 8)
      await push(
        `开始执行 · ${meta.mode}/${meta.turns} · sid=${sid} · 预计数分钟`,
      )
      if (beatMs > 0) schedule(firstMs > 0 ? firstMs : beatMs)
    },
    async continueRound(i, total) {
      lastActivity = Date.now()
      await push(`触顶续跑 ${i}/${total} · 同会话接着干`)
    },
    async interrupted(reason = '服务停止') {
      // allow one last message even if stop() was called first
      stopped = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await push(`任务中断（${reason}）· 请发「继续」接着干`)
      stopped = true
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
