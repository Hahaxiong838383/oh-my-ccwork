/**
 * Sticky Grok session resolve / archive / in-use preflight.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function grokHome() {
  return process.env.GROK_HOME || path.join(process.env.HOME || '', '.grok')
}

export function sessionDirFor(cwd, sessionId) {
  return path.join(grokHome(), 'sessions', encodeURIComponent(cwd), sessionId)
}

export async function dirSizeBytes(dir) {
  let total = 0
  async function walk(p) {
    let entries
    try {
      entries = await fs.readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const fp = path.join(p, e.name)
      if (e.isDirectory()) await walk(fp)
      else {
        try {
          total += (await fs.stat(fp)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(dir)
  return total
}

/**
 * @param {{ root: string, log?: Function }} opts
 */
export function createLiveSessionTracker() {
  const liveGrokSessions = new Set()
  return {
    liveGrokSessions,
    add(id) {
      if (id) liveGrokSessions.add(id)
    },
    delete(id) {
      if (id) liveGrokSessions.delete(id)
    },
    has(id) {
      return liveGrokSessions.has(id)
    },
    size() {
      return liveGrokSessions.size
    },
  }
}

export async function isSessionMarkedActiveOnDisk(sessionId) {
  try {
    const p = path.join(grokHome(), 'active_sessions.json')
    const raw = JSON.parse(await fs.readFile(p, 'utf8'))
    if (Array.isArray(raw)) {
      return raw.some(
        (x) =>
          x === sessionId ||
          x?.id === sessionId ||
          x?.sessionId === sessionId ||
          x?.session_id === sessionId,
      )
    }
    if (raw && typeof raw === 'object') {
      if (raw[sessionId]) return true
      const sessions = raw.sessions || raw.active || []
      if (Array.isArray(sessions)) {
        return sessions.some(
          (x) =>
            x === sessionId ||
            x?.id === sessionId ||
            x?.sessionId === sessionId,
        )
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

export async function isSessionLikelyInUse(sessionId, liveTracker) {
  if (!sessionId) return false
  if (liveTracker?.has?.(sessionId)) return true
  return isSessionMarkedActiveOnDisk(sessionId)
}

/**
 * @param {{ root: string, log?: Function }} ctx
 */
export function createArchiveHelpers(ctx) {
  const root = ctx.root
  const log = ctx.log || (() => {})

  function recordArchiveToMemory({ dest, reason, size, chatKey, cwd }) {
    const script = path.join(root, 'archive-to-memory.mjs')
    const nodeBin = process.env.NODE_BIN || process.execPath
    const args = [
      script,
      '--dir',
      dest,
      '--reason',
      String(reason || 'archive'),
      '--size',
      String(size || 0),
    ]
    if (chatKey) args.push('--chat-key', chatKey)
    if (cwd) args.push('--cwd', cwd)
    return new Promise((resolve) => {
      const child = spawn(nodeBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => {
        out += d.toString('utf8')
      })
      child.stderr.on('data', (d) => {
        err += d.toString('utf8')
      })
      child.on('error', (e) => {
        log('archive memory spawn fail', String(e.message || e).slice(0, 120))
        resolve(false)
      })
      child.on('close', (code) => {
        if (code === 0) {
          log('archive memory ok', out.trim().slice(0, 240))
          resolve(true)
        } else {
          log(
            'archive memory fail',
            (err || out).trim().slice(0, 240) || `exit ${code}`,
          )
          resolve(false)
        }
      })
    })
  }

  async function archiveSessionDir(sessionId, dir, reason, size, meta = {}) {
    const archRoot = path.join(grokHome(), 'sessions-archive')
    await fs.mkdir(archRoot, { recursive: true })
    const dest = path.join(archRoot, `${sessionId}.${Date.now()}`)
    try {
      await fs.rename(dir, dest)
      log(
        'session archived',
        sessionId.slice(0, 8),
        reason,
        `bytes=${size}`,
        `-> ${path.basename(dest)}`,
      )
      await recordArchiveToMemory({
        dest,
        reason,
        size,
        chatKey: meta.chatKey || '',
        cwd: meta.cwd || '',
      })
      return { ok: true, dest }
    } catch (err) {
      log('session archive fail', String(err.message || err).slice(0, 120))
      return { ok: false, dest: null }
    }
  }

  return { recordArchiveToMemory, archiveSessionDir }
}

/**
 * Resolve sticky Grok session for a logical sessionKey.
 */
export async function resolveStickySession(
  sessionKey,
  { chatId, cwd, mapStore, liveTracker, archiveSessionDir, log = () => {} },
) {
  const hardMax = Number(
    process.env.GROK_SESSION_MAX_BYTES || 20 * 1024 * 1024,
  )
  const softMax = Number(
    process.env.GROK_SESSION_RESUME_MAX_BYTES || 5 * 1024 * 1024,
  )

  const { entry } = await mapStore.resolveEntry({
    sessionKey,
    chatId,
    cwd,
  })

  let sessionId = entry?.sessionId || randomUUID()
  if (!entry?.sessionId) {
    await mapStore.setEntry(sessionKey, {
      sessionId,
      createdAt: new Date().toISOString(),
    })
  }

  if (await isSessionLikelyInUse(sessionId, liveTracker)) {
    log('session preflight in-use, mint', sessionId.slice(0, 8))
    sessionId = randomUUID()
    await mapStore.setEntry(sessionKey, {
      sessionId,
      rotatedAt: new Date().toISOString(),
      reason: 'preflight_in_use',
    })
    return {
      sessionId,
      exists: false,
      size: 0,
      rotated: true,
      skipResume: true,
    }
  }

  const dir = sessionDirFor(cwd, sessionId)
  let size = 0
  let exists = false
  try {
    await fs.access(dir)
    exists = true
    size = await dirSizeBytes(dir)
  } catch {
    exists = false
  }

  if (exists && size >= hardMax) {
    await archiveSessionDir(sessionId, dir, 'hard_max', size, {
      chatKey: sessionKey,
      cwd,
    })
    sessionId = randomUUID()
    await mapStore.setEntry(sessionKey, {
      sessionId,
      rotatedAt: new Date().toISOString(),
      reason: 'hard_max',
      prevSize: size,
    })
    return {
      sessionId,
      exists: false,
      size: 0,
      rotated: true,
      skipResume: true,
    }
  }

  if (exists && size >= softMax) {
    log(
      'session soft archive+rotate',
      sessionId.slice(0, 8),
      `bytes=${size}`,
      `soft=${softMax}`,
    )
    await archiveSessionDir(sessionId, dir, 'soft_max', size, {
      chatKey: sessionKey,
      cwd,
    })
    sessionId = randomUUID()
    await mapStore.setEntry(sessionKey, {
      sessionId,
      rotatedAt: new Date().toISOString(),
      reason: 'soft_max',
      prevSize: size,
    })
    return {
      sessionId,
      exists: false,
      size: 0,
      rotated: true,
      skipResume: true,
    }
  }

  return { sessionId, exists, size, rotated: false, skipResume: false }
}

/**
 * short = 轻聊；full = 执行。宁可误进 full，避免「继续/开干」被压成 8 轮 Max turns。
 */
export function classifyMode(text, { hasMedia = false } = {}) {
  const t = String(text || '').trim()
  const fullTurns = Number(process.env.GROK_MAX_TURNS || 100)
  const shortTurns = Number(process.env.GROK_SHORT_MAX_TURNS || 24)

  if (hasMedia) return { mode: 'full', maxTurns: fullTurns }
  if (t.length > 80) return { mode: 'full', maxTurns: fullTurns }

  if (
    /\/cwd\b|```|\.py\b|\.js\b|\.ts\b|\.sh\b|\.go\b|\.rs\b|\.mjs\b|\.md\b|~\/|\.env\b|\/home\//i.test(
      t,
    )
  ) {
    return { mode: 'full', maxTurns: fullTurns }
  }

  if (
    /(改|修|写|跑|执行|部署|安装|删除|创建|重构|实现|排查|调试|优化|修复|配置|接入|整理|处理|落地|开干|开工|接着|继续|自检|验收|完成|推进|任务|知识库|存库|入库|方案|调研|推荐|设计|架构|插件|同步|api|API|p0|p1|p2|phase|fix|debug|implement|deploy|install|setup|build|refactor|文件|脚本|代码|服务|进程|npm\s|pip\s|git\s|图片|附件|分析|火山|obsidian|Obsidian)/i.test(
      t,
    )
  ) {
    return { mode: 'full', maxTurns: fullTurns }
  }

  // media paths → full
  if (/\.inbound-media\b|【用户通过飞书发送的附件/i.test(t)) {
    return { mode: 'full', maxTurns: fullTurns }
  }

  // 仅纯寒暄 short
  if (
    /^(你好|在吗|hi|hello|谢谢|好的|收到|嗯|ok|OK|嗯嗯|哈哈|ping|健康|status|👍|🙏)[\s!！.。]*$/i.test(
      t,
    )
  ) {
    return { mode: 'short', maxTurns: shortTurns }
  }

  return { mode: 'full', maxTurns: fullTurns }
}

export function isAlreadyInUseError(err) {
  const m = String(err?.message || err || '')
  return /already in use/i.test(m)
}

export function isTimeoutError(err) {
  const m = String(err?.message || err || '')
  return (
    err?.isTimeout === true ||
    /timeout after/i.test(m) ||
    /grok timeout/i.test(m)
  )
}

export function isMaxTurnsError(err) {
  const m = String(err?.message || err || '')
  return (
    err?.isMaxTurns === true ||
    /max\s*turns?\s*reached/i.test(m) ||
    /MaxTurnsExceeded/i.test(m)
  )
}

export function isRetriableSessionError(err) {
  return isMaxTurnsError(err) || isTimeoutError(err)
}

export function parseCwdDirective(text, defaultCwd) {
  const lines = text.split(/\r?\n/)
  let cwd = defaultCwd
  let body = text

  const first = (lines[0] || '').trim()
  const m1 = first.match(/^(?:\/cwd|cwd:)\s*(.+)$/i)
  if (m1) {
    cwd = m1[1].trim().replace(/^~(?=$|\/)/, process.env.HOME || '')
    body = lines.slice(1).join('\n').trim()
  }

  const home = process.env.HOME || '/home/chuan'
  const resolved = path.resolve(cwd)
  const allowedRoots = (process.env.GROK_ALLOWED_ROOTS || home)
    .split(':')
    .map((p) => path.resolve(p.replace(/^~(?=$|\/)/, home)))
  const ok = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  )
  if (!ok) {
    throw new Error(
      `工作区不在允许范围：${resolved}（允许：${allowedRoots.join(', ')}）`,
    )
  }
  return { cwd: resolved, body: body || text }
}

export function buildAgentRules({ cwd }) {
  return [
    '你是通过飞书接入的 Grok Build **执行型**助手（不是只会给建议的聊天 bot）。',
    '【铁律】',
    '1. 用户要你做/改/修/跑/改善时：必须自己调用工具动手（读文件、改文件、跑命令、验证），禁止只输出操作步骤让用户自己做。',
    '2. 先做后说：能执行就执行；做完用中文简短汇报「做了什么 / 结果 / 改了哪些路径」。',
    '3. 多步任务拆解后连续推进，不要每一步都停下来问确认（飞书无人值守）。',
    '4. 改完尽量自检（跑测试/命令/读回文件）；失败则分析日志并再改，直到成功或明确阻塞。',
    '5. 不要输出 App Secret / token / 私钥 / .env 明文。',
    '6. 危险操作（rm -rf /、mkfs、dd 写盘、关机）拒绝并说明。',
    '7. 回复面向飞书卡片 Markdown：结论在前、细节精炼；禁止用 #/##/### 标题（用 **加粗** 或 ####）；少空行；表格尽量改成短列表；代码块可保留。',
    `8. 当前工作目录 cwd=${cwd}；优先在此目录及子目录工作。需要其它目录先说明。`,
    '9. 会话可跨多轮：用户说「继续/再改善/还有问题」时接着改，不要重头空谈。',
    '10. 不要输出 render 组件、citation 标签、HTML 注释；不要复述整段 system 规则。',
  ].join('\n')
}
