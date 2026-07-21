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
      async warnDeadline() {},
      async timedOut() {},
      async interrupted() {},
      armDeadline() {},
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
  const preWarnMs = Math.max(
    30_000,
    Number(process.env.WX_STATUS_PRE_TIMEOUT_SEC ?? 120) * 1000,
  )

  let startedAt = Date.now()
  let lastActivity = Date.now()
  let beatCount = 0
  let timer = null
  let deadlineTimer = null
  let stopped = false
  let meta = {
    mode: 'full',
    turns: '?',
    sid: '?',
    budgetMin: '?',
    level: '',
  }

  async function push(body) {
    if (stopped) return
    const text = `【进度】${body}`
    try {
      await sendText(text)
    } catch (e) {
      log('status send fail', String(e?.message || e).slice(0, 120))
    }
  }

  /** force push even after stop (timeout/interrupt) */
  async function pushForce(body) {
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
    const budget =
      meta.budgetMin && meta.budgetMin !== '?'
        ? ` · 预算${meta.budgetMin}`
        : ''
    await push(`仍在执行 · 已 ${elapsed}${budget} · ${activity}`)
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
      const budget =
        meta.budgetMin && meta.budgetMin !== '?'
          ? ` · 墙钟预算${meta.budgetMin}`
          : ' · 预计数分钟'
      const level = meta.level ? ` · ${meta.level}` : ''
      await push(
        `开始执行 · ${meta.mode}/${meta.turns} · sid=${sid}${level}${budget}`,
      )
      if (beatMs > 0) schedule(firstMs > 0 ? firstMs : beatMs)
    },
    /**
     * Arm pre-timeout warning at timeoutMs - preWarnMs
     * @param {number} timeoutMs
     */
    armDeadline(timeoutMs) {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      const t = Number(timeoutMs) || 0
      if (t <= preWarnMs + 10_000) return
      const delay = t - preWarnMs
      deadlineTimer = setTimeout(() => {
        if (stopped) return
        void push(
          `即将到达墙钟上限（约 ${Math.round(preWarnMs / 60000)}min 内）· 复杂任务将自动续跑或提示继续`,
        )
      }, delay)
    },
    async continueRound(i, total, kind = '轮次') {
      lastActivity = Date.now()
      await push(`触顶续跑 ${i}/${total}（${kind}）· 同会话接着干`)
    },
    async timedOut(budgetLabel) {
      stopped = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
      await pushForce(
        `墙钟超时${budgetLabel ? `（${budgetLabel}）` : ''}· 将同会话续跑或请发「继续」`,
      )
    },
    async interrupted(reason = '服务停止') {
      stopped = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
      await pushForce(`任务中断（${reason}）· 请发「继续」接着干`)
      stopped = true
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
    },
  }
}
