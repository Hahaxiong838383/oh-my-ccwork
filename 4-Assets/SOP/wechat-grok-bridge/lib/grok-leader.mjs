/**
 * 常驻 Grok leader：共享 auth/模型/热路径，供 headless `grok -p --leader-socket` 复用。
 * 崩溃自动拉起；桥进程退出时清理。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'

function envFlag(name, def = false) {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  return /^(1|true|yes|on)$/i.test(v)
}

export function leaderEnabled() {
  return envFlag('GROK_LEADER', true)
}

export function defaultLeaderSocket(root) {
  return (
    process.env.GROK_LEADER_SOCKET ||
    path.join(root || process.cwd(), 'data', 'leader.sock')
  )
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function removeStaleSocket(sockPath) {
  try {
    await fs.unlink(sockPath)
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      /* ignore busy/other */
    }
  }
}

/**
 * Probe whether something is listening on a unix socket.
 */
export function probeLeaderSocket(sockPath, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath)
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => finish(true))
    sock.on('timeout', () => finish(false))
    sock.on('error', () => finish(false))
  })
}

/**
 * @param {{
 *   root: string,
 *   log?: (...a: any[]) => void,
 * }} opts
 */
export function createGrokLeader(opts) {
  const log = opts.log || (() => {})
  const root = opts.root
  const bin = process.env.GROK_BIN || `${process.env.HOME}/.grok/bin/grok`
  const sockPath = defaultLeaderSocket(root)
  const restartMs = Math.max(
    1000,
    Number(process.env.GROK_LEADER_RESTART_MS || 3000),
  )
  const maxRestarts = Math.max(
    1,
    Number(process.env.GROK_LEADER_MAX_RESTARTS || 20),
  )

  let child = null
  let stopped = false
  let restarts = 0
  let starting = null

  function leaderArgs() {
    return [
      'agent',
      'leader',
      '--no-exit-on-disconnect',
      '--no-auto-update',
      '--relay-on-demand',
      '--leader-socket',
      sockPath,
    ]
  }

  function buildEnv() {
    return {
      ...process.env,
      PATH: `${path.dirname(bin)}:${process.env.HOME}/.local/node/bin:${process.env.HOME}/.local/bin:${process.env.PATH || ''}`,
      CI: '1',
      GROK_HEADLESS: '1',
      GROK_DISABLE_AUTOUPDATER: '1',
    }
  }

  async function waitReady(timeoutMs = 15_000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (await probeLeaderSocket(sockPath, 400)) return true
      await sleep(200)
    }
    return false
  }

  async function startOnce() {
    await fs.mkdir(path.dirname(sockPath), { recursive: true })
    // 若已有可用 leader，直接复用（避免双开）
    if (await pathExists(sockPath)) {
      if (await probeLeaderSocket(sockPath, 600)) {
        log('grok leader reuse existing socket', sockPath)
        return true
      }
      await removeStaleSocket(sockPath)
    }

    child = spawn(bin, leaderArgs(), {
      env: buildEnv(),
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    })
    const pid = child.pid
    log('grok leader spawn', `pid=${pid || '?'}`, `sock=${sockPath}`)

    let errTail = ''
    child.stderr?.on('data', (d) => {
      errTail = (errTail + d.toString('utf8')).slice(-1500)
    })
    child.on('error', (err) => {
      log('grok leader error', String(err.message || err).slice(0, 160))
    })
    child.on('close', (code, signal) => {
      log(
        'grok leader exit',
        `code=${code}`,
        `signal=${signal || '-'}`,
        errTail ? errTail.slice(-200).replace(/\n/g, ' ') : '',
      )
      child = null
      if (stopped) return
      restarts += 1
      if (restarts > maxRestarts) {
        log('grok leader give up restarts', `n=${restarts}`)
        return
      }
      setTimeout(() => {
        if (!stopped) void ensureStarted()
      }, restartMs)
    })

    const ok = await waitReady(20_000)
    if (!ok) {
      log('grok leader not ready in time', sockPath)
      try {
        child?.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      return false
    }
    restarts = 0
    log('grok leader ready', `pid=${pid || '?'}`)
    return true
  }

  async function ensureStarted() {
    if (!leaderEnabled()) return false
    if (stopped) return false
    if (starting) return starting
    starting = (async () => {
      try {
        return await startOnce()
      } finally {
        starting = null
      }
    })()
    return starting
  }

  async function stop() {
    stopped = true
    const c = child
    child = null
    if (c && !c.killed) {
      try {
        c.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          c.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 2000)
    }
    // 仅清理我们创建的 socket；若是外部 leader 复用则不动
    // 安全起见：若进程已死再删
    await sleep(300)
    if (!(await probeLeaderSocket(sockPath, 200))) {
      await removeStaleSocket(sockPath)
    }
  }

  function socketPath() {
    return sockPath
  }

  function isManagedAlive() {
    return !!(child && !child.killed)
  }

  async function status() {
    const listening = await probeLeaderSocket(sockPath, 400)
    return {
      enabled: leaderEnabled(),
      socket: sockPath,
      listening,
      managed: isManagedAlive(),
      pid: child?.pid || null,
      restarts,
    }
  }

  /** extra CLI args for headless clients */
  function clientArgs() {
    if (!leaderEnabled()) return []
    return ['--leader-socket', sockPath]
  }

  return {
    ensureStarted,
    stop,
    socketPath,
    status,
    clientArgs,
    waitReady,
  }
}
