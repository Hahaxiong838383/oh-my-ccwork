import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'

async function exists(path, mode = fsConstants.F_OK) {
  try {
    await fs.access(path, mode)
    return true
  } catch {
    return false
  }
}

export function createHEngineRuntime({ config } = {}) {
  let promptCache = null

  async function ready() {
    if (config.mode === 'demo') {
      return { ready: true, productionReady: false, provider: config.provider, mode: 'demo' }
    }
    if (config.mode === 'remote') {
      if (!config.remoteUrl || config.remoteSecret?.length < 32) {
        return { ready: false, productionReady: false, reason: 'h_engine_remote_config_missing' }
      }
      try {
        const response = await fetch(new URL('/readyz', config.remoteUrl), { signal: AbortSignal.timeout(5000) })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload.ready) {
          return { ready: false, productionReady: false, reason: payload.reason || 'h_engine_remote_not_ready' }
        }
        return {
          ready: true,
          productionReady: true,
          provider: config.provider,
          mode: 'remote',
          credentialMode: payload.credentialMode || 'remote-managed',
          engineProvider: payload.provider || 'remote-managed',
          model: payload.model || null,
        }
      } catch {
        return { ready: false, productionReady: false, reason: 'h_engine_remote_unreachable' }
      }
    }
    if (config.mode !== 'cli') return { ready: false, productionReady: false, reason: 'h_engine_mode_invalid' }
    if (!(await exists(config.bin, fsConstants.X_OK))) return { ready: false, productionReady: false, reason: 'h_engine_cli_missing' }
    if (!(await exists(config.home))) return { ready: false, productionReady: false, reason: 'h_engine_home_missing' }
    if (!(await exists(config.workspace))) return { ready: false, productionReady: false, reason: 'h_engine_workspace_missing' }
    if (!(await exists(config.promptFile))) return { ready: false, reason: 'system_prompt_missing' }
    if (!config.apiKey && !(await exists(`${config.grokHome}/auth.json`))) {
      return { ready: false, productionReady: false, reason: 'h_engine_credentials_missing' }
    }
    return {
      ready: true,
      productionReady: true,
      provider: config.provider,
      mode: 'cli',
      proxyConfigured: Boolean(config.proxyUrl),
    }
  }

  async function systemPrompt() {
    if (promptCache === null) promptCache = await fs.readFile(config.promptFile, 'utf8')
    return promptCache
  }

  async function compiledPrompt(turn) {
    const workContext = turn.workContext && typeof turn.workContext === 'object' ? turn.workContext : null
    return [
      await systemPrompt(),
      `当前意图：${turn.intent}`,
      `会话标识：${turn.conversationId}`,
      workContext?.processingMode === 'active' ? `Company Brain Work Protocol：\n${JSON.stringify({
        caseId: workContext.caseId,
        workMode: workContext.workMode,
        evidencePackage: workContext.evidencePackage,
        epistemicAssessment: workContext.assessment,
        responseContract: {
          conclusion: 'string',
          factBasis: 'string[]',
          derivedSummary: 'string',
          assumptions: 'string[]',
          contradictions: 'string[]',
          unknowns: 'string[]',
          confidenceLevel: 'high|medium|low|insufficient',
          validityWindow: { validUntil: 'ISO timestamp|null' },
          recommendedNextAction: 'string',
          approvalRequired: 'boolean',
          evidenceReferences: 'authorized evidenceId[]',
        },
      })}` : '',
      workContext?.processingMode === 'active'
        ? '只输出一个 JSON 对象，不要 Markdown，不要代码围栏，不要输出或保存隐藏思维链、内部推理过程或 reasoning 字段。只能引用 Evidence Package 中的 evidenceId。'
        : turn.evidence?.length ? `权限化证据：\n${JSON.stringify(turn.evidence)}` : '',
      '用户请求：',
      turn.message,
    ].filter(Boolean).join('\n\n')
  }

  async function runRemote(turn) {
    const body = JSON.stringify({
      prompt: await compiledPrompt(turn),
      conversationId: turn.conversationId,
      requestId: turn.requestId || '',
    })
    const timestamp = String(Date.now())
    const signature = createHmac('sha256', config.remoteSecret).update(`${timestamp}.${body}`).digest('hex')
    let response
    try {
      response = await fetch(config.remoteUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-h-engine-timestamp': timestamp,
          'x-h-engine-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (error) {
      const wrapped = new Error('H Engine remote request failed')
      wrapped.code = error?.name === 'TimeoutError' ? 'runtime_timeout' : 'runtime_failed'
      throw wrapped
    }
    const text = await response.text()
    if (Buffer.byteLength(text) > config.maxOutputBytes) {
      const error = new Error('H Engine remote output exceeded limit')
      error.code = 'runtime_output_limit'
      throw error
    }
    let payload
    try {
      payload = JSON.parse(text || '{}')
    } catch {
      const error = new Error('H Engine remote returned invalid JSON')
      error.code = 'runtime_failed'
      throw error
    }
    if (!response.ok || !payload.ok || typeof payload.reply !== 'string') {
      const error = new Error('H Engine remote runtime failed')
      error.code = String(payload.status || 'runtime_failed')
      throw error
    }
    return {
      reply: payload.reply.trim(),
      runtime: {
        provider: config.provider,
        mode: 'remote',
        simulation: false,
        productionReady: true,
        credentialMode: payload.runtime?.credentialMode || 'remote-managed',
        engineProvider: payload.runtime?.provider || 'remote-managed',
        model: payload.runtime?.model || null,
        workerVersion: payload.runtime?.workerVersion || null,
      },
    }
  }

  async function runCli(turn) {
    const compiled = await compiledPrompt(turn)
    return new Promise((resolve, reject) => {
      const child = spawn(config.bin, ['-p', compiled], {
        cwd: config.workspace,
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: config.home,
          GROK_HOME: config.grokHome,
          XAI_API_KEY: config.apiKey,
          ALL_PROXY: config.proxyUrl,
          HTTPS_PROXY: config.proxyUrl,
          HTTP_PROXY: config.proxyUrl,
          NO_PROXY: '127.0.0.1,localhost,postgres,redis,qdrant,agent-core,h-lite,action-gateway,knowledge-connector',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      let settled = false
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        const error = new Error('H Engine runtime timed out')
        error.code = 'runtime_timeout'
        settle(error)
      }, config.timeoutMs)
      timer.unref?.()

      function collect(current, chunk) {
        const next = Buffer.concat([current, chunk])
        if (next.length > config.maxOutputBytes) {
          child.kill('SIGTERM')
          const error = new Error('H Engine runtime output exceeded limit')
          error.code = 'runtime_output_limit'
          settle(error)
          return current
        }
        return next
      }

      function settle(error, value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }

      child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk) })
      child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk) })
      child.on('error', (error) => settle(error))
      child.on('close', (code) => {
        if (settled) return
        if (code !== 0) {
          const error = new Error(`H Engine runtime exited with code ${code}: ${stderr.toString('utf8').slice(-500)}`)
          error.code = 'runtime_failed'
          settle(error)
          return
        }
        settle(null, {
          reply: stdout.toString('utf8').trim(),
          runtime: {
            provider: config.provider,
            mode: 'cli',
            simulation: false,
            productionReady: true,
            exitCode: code,
          },
        })
      })
    })
  }

  async function run(turn) {
    const readiness = await ready()
    if (!readiness.ready) {
      const error = new Error(readiness.reason)
      error.code = 'runtime_not_ready'
      error.statusCode = 503
      error.runtime = readiness
      throw error
    }
    if (config.mode === 'demo') {
      if (config.demoDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.demoDelayMs))
      const evidenceCount = Array.isArray(turn.evidence) ? turn.evidence.length : 0
      const reply = turn.workContext?.processingMode === 'active'
        ? JSON.stringify({
            conclusion: evidenceCount ? '演示模式已根据权限化证据生成回答。' : '当前可用证据不足，无法形成确定性结论。',
            factBasis: evidenceCount ? [`已加载 ${evidenceCount} 条权限化证据`] : [],
            derivedSummary: '演示模式不代表生产业务结论。',
            assumptions: [],
            contradictions: [],
            unknowns: evidenceCount ? [] : ['未检索到权限化证据'],
            confidenceLevel: evidenceCount ? 'medium' : 'insufficient',
            validityWindow: { validUntil: turn.workContext?.evidencePackage?.validUntil || null },
            recommendedNextAction: '使用生产 H 引擎和真实授权证据复核。',
            approvalRequired: false,
            evidenceReferences: turn.workContext?.evidencePackage?.facts?.map((item) => item.evidenceId) || [],
          })
        : `【演示模式】H 引擎已处理请求：${turn.message.slice(0, 300)}${evidenceCount ? `；已加载 ${evidenceCount} 条权限化证据` : ''}`
      return {
        reply,
        runtime: { provider: config.provider, mode: 'demo', simulation: true, productionReady: false },
      }
    }
    if (config.mode === 'remote') return runRemote(turn)
    return runCli(turn)
  }

  return { ready, run }
}
