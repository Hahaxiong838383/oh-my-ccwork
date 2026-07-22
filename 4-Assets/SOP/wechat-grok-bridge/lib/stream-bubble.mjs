/**
 * 微信流式气泡：解析 grok streaming-json，节流向微信追加文本。
 * iLink 无「改同一条消息」能力 → 用节流多条 delta，最终只补未发后缀 + 附件。
 */

function envFlag(name, def = false) {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  return /^(1|true|yes|on)$/i.test(v)
}

export function streamEnabled() {
  return envFlag('WX_STREAM', true)
}

/** 去掉出站文件标记，避免半截路径刷屏 */
export function stripOutboundMarkers(text) {
  return String(text || '')
    .replace(/\[\[send-file:[^\]]+\]\]/gi, '')
    .replace(/本地路径:\s*\S+/g, '')
}

/**
 * @param {{
 *   sendText: (text: string) => Promise<void>,
 *   log?: (...a: any[]) => void,
 * }} opts
 */
export function createStreamBubble(opts) {
  const sendText = opts.sendText
  const log = opts.log || (() => {})

  if (!streamEnabled()) {
    return {
      enabled: false,
      onText() {},
      onThought() {},
      onToolHint() {},
      noteActivity() {},
      async flush() {},
      async finalize() {
        return { fullText: '', streamedText: '', pending: '' }
      },
      getFullText: () => '',
      getStreamedText: () => '',
      getPending: () => '',
      stop() {},
    }
  }

  const intervalMs = Math.max(
    400,
    Number(process.env.WX_STREAM_INTERVAL_MS ?? 1800),
  )
  const minChars = Math.max(1, Number(process.env.WX_STREAM_MIN_CHARS ?? 48))
  const maxChunk = Math.max(
    200,
    Number(process.env.WX_STREAM_MAX_CHARS ?? 1600),
  )
  const firstPrefix =
    process.env.WX_STREAM_PREFIX || '【进行中】\n'
  const thoughtAsProgress = envFlag('WX_STREAM_THOUGHT', false)
  const thoughtIntervalMs = Math.max(
    5000,
    Number(process.env.WX_STREAM_THOUGHT_INTERVAL_MS ?? 45_000),
  )

  let fullText = ''
  let streamedText = '' // 已发往微信的累计（不含前缀）
  let pending = ''
  let firstSent = false
  let stopped = false
  let flushing = false
  let lastFlushAt = 0
  let lastThoughtPush = 0
  let timer = null
  let thoughtBuf = ''

  function schedule() {
    if (stopped || timer) return
    const wait = Math.max(0, intervalMs - (Date.now() - lastFlushAt))
    timer = setTimeout(() => {
      timer = null
      void flush(false)
    }, wait || intervalMs)
  }

  async function pushDelta(delta) {
    if (!delta) return
    const body = firstSent
      ? delta
      : `${firstPrefix}${delta}`
    firstSent = true
    try {
      await sendText(body)
      lastFlushAt = Date.now()
    } catch (e) {
      log('stream bubble send fail', String(e?.message || e).slice(0, 120))
    }
  }

  /**
   * @param {boolean} force
   */
  async function flush(force = false) {
    if (stopped || flushing) return
    const cleanPending = stripOutboundMarkers(pending)
    if (!cleanPending) {
      pending = stripOutboundMarkers(pending) === pending ? pending : ''
      // still drop markers from pending even if empty visual
      pending = pending.replace(/\[\[send-file:[^\]]+\]\]/gi, '')
      return
    }
    const elapsed = Date.now() - lastFlushAt
    const enoughTime = force || elapsed >= intervalMs || !firstSent
    const enoughChars = force || cleanPending.length >= minChars || !firstSent
    if (!force && !(enoughTime && enoughChars)) {
      schedule()
      return
    }

    flushing = true
    try {
      // 按微信长度切分
      while (pending.length > 0) {
        const visual = stripOutboundMarkers(pending)
        if (!visual.trim()) {
          // 只剩标记：保留在 pending 给 final 处理 fullText，清空显示缓冲
          pending = ''
          break
        }
        // 从 pending 取一段可显示文本（尽量对齐 visual 前缀）
        let take = Math.min(maxChunk, visual.length)
        // 优先在换行/句号处切开
        if (take < visual.length) {
          const slice = visual.slice(0, take)
          const br = Math.max(
            slice.lastIndexOf('\n\n'),
            slice.lastIndexOf('\n'),
            slice.lastIndexOf('。'),
            slice.lastIndexOf('！'),
            slice.lastIndexOf('？'),
            slice.lastIndexOf('. '),
          )
          if (br > 40) take = br + 1
        }
        const delta = visual.slice(0, take)
        // 从 pending 移除对应内容（markers 可能夹杂——简化：整段用 strip 后同步）
        // 策略：把 pending 设为 strip 后的剩余
        const restVisual = visual.slice(take)
        // 保留尚未解析完的 send-file 标记：从原 pending 里抠出尚未展示的 markers
        const markers = [...pending.matchAll(/\[\[send-file:[^\]]+\]\]/gi)].map(
          (m) => m[0],
        )
        pending = restVisual
        // markers 不进入 streamed 显示，final 用 fullText 处理
        void markers
        await pushDelta(delta)
        streamedText += delta
        if (!force && pending.length > 0 && Date.now() - lastFlushAt < 200) {
          // 连发保护
          await new Promise((r) => setTimeout(r, 250))
        }
        if (!force && pending.length > 0) {
          // 非 force 只冲一段，其余下轮
          break
        }
      }
    } finally {
      flushing = false
      if (!stopped && stripOutboundMarkers(pending).length >= minChars) {
        schedule()
      }
    }
  }

  return {
    enabled: true,
    onText(chunk) {
      if (stopped || chunk == null) return
      const s = String(chunk)
      fullText += s
      pending += s
      schedule()
    },
    onThought(chunk) {
      if (stopped || !thoughtAsProgress) return
      thoughtBuf = (thoughtBuf + String(chunk || '')).slice(-200)
      const now = Date.now()
      if (now - lastThoughtPush < thoughtIntervalMs) return
      lastThoughtPush = now
      const hint = thoughtBuf.replace(/\s+/g, ' ').trim().slice(0, 80)
      if (!hint) return
      void sendText(`【进度】思考中… ${hint}`).catch(() => {})
    },
    onToolHint(title) {
      if (stopped) return
      const t = String(title || '').trim().slice(0, 100)
      if (!t) return
      // 工具阶段无 text 时给一记可见反馈（低频）
      const now = Date.now()
      if (now - lastThoughtPush < 12_000) return
      lastThoughtPush = now
      void sendText(`【进度】工具 · ${t}`).catch(() => {})
    },
    noteActivity() {},
    flush,
    async finalize() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await flush(true)
      return {
        fullText,
        streamedText,
        pending: stripOutboundMarkers(pending),
      }
    },
    getFullText: () => fullText,
    getStreamedText: () => streamedText,
    getPending: () => pending,
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/**
 * 定稿时计算「尚未流式发出」的文本后缀（用于避免全文重复刷屏）。
 * streamed 与 full 在 normalize 前后可能略有差异，做前缀对齐。
 */
export function remainingAfterStream(fullNormalized, streamedRaw) {
  const full = String(fullNormalized || '')
  const streamed = stripOutboundMarkers(String(streamedRaw || '')).trimEnd()
  if (!streamed) return full
  if (full.startsWith(streamed)) return full.slice(streamed.length).trimStart()
  // 宽松：去掉空白后再比
  const fullNs = full.replace(/\s+/g, '')
  const stNs = streamed.replace(/\s+/g, '')
  if (fullNs.startsWith(stNs)) {
    // 无法精确映射回带空白版本时，若已流大部分则只提示完成
    if (stNs.length >= fullNs.length * 0.85) {
      return full.length > streamed.length
        ? full.slice(Math.min(streamed.length, full.length)).trimStart()
        : ''
    }
  }
  // 对不齐：保守全文再发（宁可重复，不丢结论）
  return full
}

/**
 * 从 streaming-json 一行解析事件；非法行返回 null。
 */
export function parseStreamLine(line) {
  const t = String(line || '').trim()
  if (!t || t[0] !== '{') return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}
