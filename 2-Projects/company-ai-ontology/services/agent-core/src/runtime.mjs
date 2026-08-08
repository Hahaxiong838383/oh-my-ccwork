import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

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

  async function run(turn) {
    const readiness = await ready()
    if (!readiness.ready) {
      const error = new Error(readiness.reason)
      error.code = 'runtime_not_ready'
      error.runtime = readiness
      throw error
    }
    if (config.mode === 'demo') {
      if (config.demoDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.demoDelayMs))
      const evidenceCount = Array.isArray(turn.evidence) ? turn.evidence.length : 0
      return {
        reply: `【演示模式】H 引擎已处理请求：${turn.message.slice(0, 300)}${evidenceCount ? `；已加载 ${evidenceCount} 条权限化证据` : ''}`,
        runtime: {
          provider: config.provider,
          mode: 'demo',
          simulation: true,
          productionReady: false,
        },
      }
    }
    const compiled = [
      await systemPrompt(),
      `当前意图：${turn.intent}`,
      `会话标识：${turn.conversationId}`,
      turn.evidence?.length ? `权限化证据：\n${JSON.stringify(turn.evidence)}` : '',
      '用户请求：',
      turn.message,
    ].filter(Boolean).join('\n\n')

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
          NO_PROXY: '127.0.0.1,localhost,postgres,redis,qdrant,agent-core,h-lite,action-gateway',
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

  return { ready, run }
}
