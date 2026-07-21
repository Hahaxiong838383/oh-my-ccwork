/**
 * Dynamic wall-clock budget from task complexity (not a single fixed timeout).
 *
 * Env floors/ceilings (ms unless noted):
 *   GROK_TIMEOUT_MIN_MS   default 8min
 *   GROK_TIMEOUT_MAX_MS   default 45min
 *   GROK_TIMEOUT_MS       optional soft baseline (default 15min) — only used as mid anchor
 */

function numEnv(name, def) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : def
}

/**
 * @param {string} text
 * @param {{ mode?: string, hasMedia?: boolean }} opts
 * @returns {{
 *   score: number,
 *   level: 'light'|'standard'|'heavy'|'extreme',
 *   timeoutMs: number,
 *   reason: string,
 * }}
 */
export function estimateTaskBudget(text, opts = {}) {
  const t = String(text || '').trim()
  const mode = opts.mode || 'full'
  const hasMedia = !!opts.hasMedia

  const minMs = numEnv('GROK_TIMEOUT_MIN_MS', 8 * 60_000)
  const maxMs = numEnv('GROK_TIMEOUT_MAX_MS', 45 * 60_000)
  // baseline only as reference for standard tasks; not a hard fixed value
  const midMs = numEnv('GROK_TIMEOUT_MS', 15 * 60_000)

  let score = 0
  const tags = []

  if (mode === 'full') {
    score += 2
    tags.push('full')
  } else {
    score += 0
    tags.push('short')
  }

  if (hasMedia) {
    score += 1
    tags.push('media')
  }

  const len = t.length
  if (len > 120) {
    score += 1
    tags.push('len>120')
  }
  if (len > 300) {
    score += 1
    tags.push('len>300')
  }
  if (len > 800) {
    score += 1
    tags.push('len>800')
  }

  // heavy multi-step / deploy
  if (
    /(部署|安装|迁移|重构|全量|知识库|vault|obsidian|second-brain|入库|存库|自检|验收|p0|p1|p2|phase|开干|落地|实现|接入)/i.test(
      t,
    )
  ) {
    score += 3
    tags.push('deploy')
  }

  // research / design still tool-heavy
  if (/(调研|方案|架构|推荐|对比|分析|设计)/i.test(t)) {
    score += 1
    tags.push('design')
  }

  // continuation of long work
  if (/(继续|接着|接着干|resume|续跑)/i.test(t)) {
    score += 2
    tags.push('continue')
  }

  // many steps implied
  if (/(并且|然后|之后|同时|以及|1\)|2\)|3\)|①|②|③)/.test(t)) {
    score += 1
    tags.push('multi-step')
  }

  // forbid self-restart hints still heavy
  if (/systemctl|restart|服务/.test(t)) {
    score += 1
    tags.push('ops')
  }

  /** score → timeout */
  let timeoutMs
  let level
  if (mode === 'short' && score <= 1) {
    level = 'light'
    timeoutMs = Math.min(midMs, Math.max(minMs, 8 * 60_000))
  } else if (score <= 3) {
    level = 'standard'
    timeoutMs = Math.max(minMs, Math.min(maxMs, midMs))
  } else if (score <= 6) {
    level = 'heavy'
    timeoutMs = Math.max(minMs, Math.min(maxMs, 30 * 60_000))
  } else {
    level = 'extreme'
    timeoutMs = maxMs
  }

  // clamp
  timeoutMs = Math.max(minMs, Math.min(maxMs, timeoutMs))

  return {
    score,
    level,
    timeoutMs,
    reason: tags.join('+') || 'default',
  }
}

export function formatBudgetMin(ms) {
  const m = Math.round(Number(ms) / 60_000)
  return `${m}min`
}
