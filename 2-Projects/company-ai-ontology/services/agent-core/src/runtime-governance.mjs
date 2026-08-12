const RETRYABLE_CODES = new Set([
  'runtime_timeout',
  'runtime_network_error',
  'rate_limited',
  'upstream_5xx',
])

function governedError(message, code, statusCode = 503, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details })
}

function nonNegativeInteger(value, fallback) {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function usageFrom(result) {
  const runtime = result?.runtime || {}
  const usage = runtime.usage && typeof runtime.usage === 'object' ? runtime.usage : {}
  const promptTokens = nonNegativeInteger(usage.promptTokens ?? usage.prompt_tokens, 0)
  const completionTokens = nonNegativeInteger(usage.completionTokens ?? usage.completion_tokens, 0)
  return {
    promptTokens,
    completionTokens,
    totalTokens: nonNegativeInteger(usage.totalTokens ?? usage.total_tokens, promptTokens + completionTokens),
    estimatedCostMicros: nonNegativeInteger(usage.estimatedCostMicros ?? usage.estimated_cost_micros, 0),
  }
}

function hasCompleteUsageReadback(result) {
  const usage = result?.runtime?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false
  const promptTokens = Number(usage.promptTokens ?? usage.prompt_tokens)
  const completionTokens = Number(usage.completionTokens ?? usage.completion_tokens)
  const totalTokens = Number(usage.totalTokens ?? usage.total_tokens)
  return [promptTokens, completionTokens, totalTokens]
    .every((value) => Number.isFinite(value) && value >= 0 && Number.isInteger(value))
    && totalTokens >= promptTokens + completionTokens
}

function dateKey(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function estimatePromptTokens(value) {
  return Math.max(1, Math.ceil(String(value || '').length / 4))
}

export function createRuntimeGovernor({ policy = {}, ledger = null, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const routes = {
    'route-a': { enabled: true, failures: 0, openUntil: 0 },
    'route-b': { enabled: policy.routeBEnabled === true, failures: 0, openUntil: 0 },
  }
  const limits = {
    maxRetries: nonNegativeInteger(policy.maxRetries, 2),
    maxRetriesPerDay: nonNegativeInteger(policy.maxRetriesPerDay, 200),
    retryBaseMs: Math.max(1, nonNegativeInteger(policy.retryBaseMs, 250)),
    failureThreshold: Math.max(1, nonNegativeInteger(policy.failureThreshold, 3)),
    resetAfterMs: Math.max(1_000, nonNegativeInteger(policy.resetAfterMs, 60_000)),
    maxRequestsPerDay: Math.max(1, nonNegativeInteger(policy.maxRequestsPerDay, 5_000)),
    maxPromptTokensPerRequest: Math.max(1, nonNegativeInteger(policy.maxPromptTokensPerRequest, 120_000)),
    maxTotalTokensPerRequest: Math.max(1, nonNegativeInteger(policy.maxTotalTokensPerRequest, 160_000)),
    maxTokensPerDay: Math.max(1, nonNegativeInteger(policy.maxTokensPerDay, 20_000_000)),
    maxCostMicrosPerRequest: Math.max(0, nonNegativeInteger(policy.maxCostMicrosPerRequest, 0)),
    maxCostMicrosPerDay: Math.max(0, nonNegativeInteger(policy.maxCostMicrosPerDay, 0)),
    requireModelReadback: policy.requireModelReadback === true,
    requireUsageReadback: policy.requireUsageReadback === true,
    timeZone: String(policy.timeZone || 'Asia/Shanghai'),
  }
  let daily = { key: '', hydrated: false, requests: 0, retries: 0, tokens: 0, costMicros: 0, blocked: 0 }

  async function currentDaily(nowMs, routeKey) {
    const key = dateKey(nowMs, limits.timeZone)
    if (daily.key !== key) daily = { key, hydrated: false, requests: 0, retries: 0, tokens: 0, costMicros: 0, blocked: 0 }
    if (!daily.hydrated) {
      const persisted = ledger?.readDaily ? await ledger.readDaily({ date: key, routeKey }) : null
      if (persisted) {
        daily.requests = nonNegativeInteger(persisted.requests, 0)
        daily.retries = nonNegativeInteger(persisted.retries, 0)
        daily.tokens = nonNegativeInteger(persisted.tokens, 0)
        daily.costMicros = nonNegativeInteger(persisted.costMicros, 0)
      }
      daily.hydrated = true
    }
    return daily
  }

  function denyBudget(message, details = {}) {
    daily.blocked += 1
    throw governedError(message, 'budget_blocked', 429, details)
  }

  async function assertPreflight({ routeKey, estimatedPromptTokens }) {
    const nowMs = now()
    const route = routes[routeKey]
    if (!route?.enabled) throw governedError('H Engine route is disabled', 'route_disabled', 503, { routeKey })
    if (route.openUntil > nowMs) throw governedError('H Engine route circuit is open', 'circuit_open', 503, { routeKey, retryAfterMs: route.openUntil - nowMs })
    if (route.openUntil && route.openUntil <= nowMs) {
      route.openUntil = 0
      route.failures = 0
    }
    const counters = await currentDaily(nowMs, routeKey)
    if (counters.requests >= limits.maxRequestsPerDay) denyBudget('daily request budget exceeded', { budget: 'requests_per_day' })
    if (estimatedPromptTokens > limits.maxPromptTokensPerRequest) denyBudget('request prompt token budget exceeded', { budget: 'prompt_tokens_per_request' })
    if (counters.tokens + estimatedPromptTokens > limits.maxTokensPerDay) denyBudget('daily token budget exceeded', { budget: 'tokens_per_day' })
    counters.requests += 1
    counters.tokens += estimatedPromptTokens
    return route
  }

  function applyUsage(usage, estimatedPromptTokens) {
    const accountedPromptTokens = Math.max(usage.promptTokens, estimatedPromptTokens)
    const accountedTotalTokens = Math.max(usage.totalTokens, accountedPromptTokens + usage.completionTokens)
    const accountedUsage = { ...usage, promptTokens: accountedPromptTokens, totalTokens: accountedTotalTokens }
    daily.tokens += Math.max(0, accountedTotalTokens - estimatedPromptTokens)
    daily.costMicros += usage.estimatedCostMicros
    if (accountedTotalTokens > limits.maxTotalTokensPerRequest) {
      const error = governedError('request total token budget exceeded', 'budget_blocked', 429, { budget: 'total_tokens_per_request' })
      error.accountedUsage = accountedUsage
      throw error
    }
    if (daily.tokens > limits.maxTokensPerDay) {
      const error = governedError('daily token budget exceeded', 'budget_blocked', 429, { budget: 'tokens_per_day' })
      error.accountedUsage = accountedUsage
      throw error
    }
    if (limits.maxCostMicrosPerRequest > 0 && usage.estimatedCostMicros > limits.maxCostMicrosPerRequest) {
      const error = governedError('request cost budget exceeded', 'budget_blocked', 429, { budget: 'cost_per_request' })
      error.accountedUsage = accountedUsage
      throw error
    }
    if (limits.maxCostMicrosPerDay > 0 && daily.costMicros > limits.maxCostMicrosPerDay) {
      const error = governedError('daily cost budget exceeded', 'budget_blocked', 429, { budget: 'cost_per_day' })
      error.accountedUsage = accountedUsage
      throw error
    }
    return accountedUsage
  }

  async function execute({ routeKey = 'route-a', estimatedPromptTokens = 0, context = {}, operation } = {}) {
    if (typeof operation !== 'function') throw new Error('runtime operation is required')
    const estimate = Math.max(0, nonNegativeInteger(estimatedPromptTokens, 0))
    const route = await assertPreflight({ routeKey, estimatedPromptTokens: estimate })
    let attempt = 0
    let consumedRuntime = null
    while (true) {
      try {
        const result = await operation({ attempt, routeKey })
        const providerReadback = result?.runtime?.engineProvider || result?.runtime?.provider
        if (limits.requireModelReadback && (!providerReadback || !result?.runtime?.model)) {
          throw governedError('runtime provider/model readback missing', 'runtime_readback_missing', 502)
        }
        if (limits.requireUsageReadback && !hasCompleteUsageReadback(result)) {
          throw governedError('runtime usage readback missing', 'runtime_usage_readback_missing', 502)
        }
        const normalizedUsage = usageFrom(result)
        consumedRuntime = { ...(result.runtime || {}), usage: normalizedUsage }
        const usage = applyUsage(normalizedUsage, estimate)
        route.failures = 0
        const governedResult = {
          ...result,
          runtime: {
            ...(result.runtime || {}),
            usage,
            governance: {
              routeKey,
              attempts: attempt + 1,
              retryCount: attempt,
              circuitState: 'closed',
              routeBEnabled: routes['route-b'].enabled,
              credentialModeTag: String(policy.credentialModeTag || 'temporary_personal_credential'),
              ledgerRecorded: Boolean(ledger?.record),
            },
          },
        }
        if (ledger?.record) await ledger.record({ routeKey, context, runtime: governedResult.runtime, outcome: 'succeeded' })
        return governedResult
      } catch (error) {
        if (error?.code === 'budget_blocked') {
          daily.blocked += 1
          if (error.accountedUsage && consumedRuntime && ledger?.record) {
            await ledger.record({
              routeKey,
              context,
              runtime: {
                ...consumedRuntime,
                usage: error.accountedUsage,
                governance: {
                  routeKey,
                  attempts: attempt + 1,
                  retryCount: attempt,
                  credentialModeTag: String(policy.credentialModeTag || 'temporary_personal_credential'),
                  ledgerRecorded: true,
                },
              },
              outcome: 'budget_blocked',
            })
          }
          throw error
        }
        const retryable = RETRYABLE_CODES.has(String(error?.code || ''))
        route.failures += 1
        if (route.failures >= limits.failureThreshold) route.openUntil = now() + limits.resetAfterMs
        if (!retryable || attempt >= limits.maxRetries || daily.retries >= limits.maxRetriesPerDay || route.openUntil > now()) {
          if (daily.retries >= limits.maxRetriesPerDay && retryable) {
            throw governedError('daily retry budget exceeded', 'retry_budget_blocked', 429, { routeKey })
          }
          if (ledger?.record) {
            await ledger.record({
              routeKey,
              context,
              runtime: {
                ...(error?.runtime || {}),
                usage: { promptTokens: estimate, completionTokens: 0, totalTokens: estimate, estimatedCostMicros: 0 },
                governance: {
                  routeKey,
                  attempts: attempt + 1,
                  retryCount: attempt,
                  credentialModeTag: String(policy.credentialModeTag || 'temporary_personal_credential'),
                  ledgerRecorded: Boolean(ledger?.record),
                },
              },
              outcome: String(error?.code || 'runtime_failed'),
            })
          }
          throw error
        }
        attempt += 1
        daily.retries += 1
        await sleep(limits.retryBaseMs * (2 ** (attempt - 1)))
      }
    }
  }

  function snapshot() {
    const nowMs = now()
    const key = dateKey(nowMs, limits.timeZone)
    if (daily.key !== key) daily = { key, hydrated: false, requests: 0, retries: 0, tokens: 0, costMicros: 0, blocked: 0 }
    return {
      routeA: { enabled: routes['route-a'].enabled, circuitState: routes['route-a'].openUntil > nowMs ? 'open' : 'closed' },
      routeB: { enabled: routes['route-b'].enabled, circuitState: routes['route-b'].openUntil > nowMs ? 'open' : 'closed' },
      daily: { ...daily },
      limits: { ...limits },
    }
  }

  return { execute, snapshot }
}
