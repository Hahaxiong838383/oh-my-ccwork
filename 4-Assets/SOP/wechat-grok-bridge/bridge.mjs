#!/usr/bin/env node
/**
 * wechat-grok-bridge
 * 微信 iLink Bot（getupdates 长轮询）↔ Grok Build headless
 *
 * 流程：getupdates → 白名单/群策略 → 媒体下载 → grok -p → 文本+出站媒体
 * 凭据：wechat-qr-login-module AES 加密 accounts.json
 * 机制对齐 dev198 feishu-grok-bridge（session 轮转 / archive-to-memory / short|full / media）
 */
import { spawn } from 'node:child_process'
import {
  createHash,
  createDecipheriv,
  randomUUID,
} from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getWechatUpdates,
  sendWechatText,
} from './wechat-api.mjs'
import {
  downloadInboundMedia,
  formatMediaPrompt,
} from './lib/media-inbound.mjs'
import { processOutboundReply } from './lib/media-outbound.mjs'
import {
  extractWechatText,
  hasMediaItems,
  detectChatKind,
  stripForcePrefix,
  shouldProcessMessage,
} from './lib/message-parse.mjs'
import { buildSessionKey } from './lib/session-key.mjs'
import {
  createProgressReporter,
  formatElapsed,
} from './lib/progress-status.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname

async function loadEnvFile(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i <= 0) continue
      const k = t.slice(0, i).trim()
      let v = t.slice(i + 1).trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      if (process.env[k] === undefined) process.env[k] = v
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`
  console.log(line)
  const file = process.env.LOG_FILE
  if (file) fs.appendFile(file, `${line}\n`).catch(() => {})
}

function decryptSecret(secretKey, value) {
  const key = createHash('sha256').update(secretKey, 'utf8').digest()
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(value.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

async function loadCredential() {
  const secret = process.env.WECHAT_CREDENTIAL_SECRET
  const filePath = process.env.WECHAT_ACCOUNTS_FILE
  if (!secret || secret.length < 32) {
    throw new Error('WECHAT_CREDENTIAL_SECRET missing/too short (>=32)')
  }
  if (!filePath) throw new Error('WECHAT_ACCOUNTS_FILE missing')
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'))
  const accounts = Object.values(raw.accounts || {})
  if (!accounts.length) throw new Error('no accounts — scan WeChat QR first')
  accounts.sort((a, b) =>
    String(b.savedAt || '').localeCompare(String(a.savedAt || '')),
  )
  const acc = accounts[0]
  const token =
    typeof acc.token === 'string' ? acc.token : decryptSecret(secret, acc.token)
  return {
    accountId: acc.accountId,
    token,
    baseUrl: acc.baseUrl || 'https://ilinkai.weixin.qq.com',
    userId: acc.userId || '',
    name: acc.name || '',
    savedAt: acc.savedAt,
  }
}

function parseAllowList(credentialUserId) {
  const extra = (process.env.ALLOW_USER_IDS || process.env.ALLOW_OPEN_IDS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const set = new Set(extra)
  if (credentialUserId) set.add(credentialUserId)
  return set
}

function splitText(text, limit = 1800) {
  const chunks = []
  let rest = String(text || '')
  while (rest.length > limit) {
    const slice = rest.slice(0, limit)
    const breakAt = Math.max(
      slice.lastIndexOf('\n\n'),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf(' '),
    )
    const cut = breakAt > 400 ? breakAt : limit
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.length ? chunks : ['(空回复)']
}

function normalizeReply(text) {
  let s = String(text || '')
  if (s.includes('\\n') && !s.includes('\n')) s = s.replace(/\\n/g, '\n')
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  s = s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  s = s.replace(/^#{1,3}\s+(.+)$/gm, (_, title) => `【${title.trim()}】`)
  s = s.replace(/^<!--[\s\S]*?-->$/gm, '')
  return s || '(空回复)'
}

function grokHome() {
  return process.env.GROK_HOME || path.join(process.env.HOME || '', '.grok')
}

function sessionMapPath() {
  return (
    process.env.GROK_SESSION_MAP ||
    path.join(ROOT, 'workspace', '.session-map.json')
  )
}

function syncBufPath(accountId) {
  return path.join(ROOT, 'data', `sync-buf-${accountId || 'default'}.json`)
}

function seenPath() {
  return path.join(ROOT, 'workspace', '.msg-dedupe.json')
}

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch {
    return fallback
  }
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

async function loadSessionMap() {
  return loadJson(sessionMapPath(), {})
}

async function saveSessionMap(map) {
  await saveJson(sessionMapPath(), map)
}

async function loadSyncBuf(accountId) {
  const d = await loadJson(syncBufPath(accountId), {})
  return typeof d.get_updates_buf === 'string' ? d.get_updates_buf : ''
}

async function saveSyncBuf(accountId, buf) {
  await saveJson(syncBufPath(accountId), { get_updates_buf: buf || '' })
}

async function hasSeen(key) {
  const d = await loadJson(seenPath(), { keys: [] })
  return (d.keys || []).includes(key)
}

async function markSeen(key) {
  const d = await loadJson(seenPath(), { keys: [] })
  const keys = d.keys || []
  keys.push(key)
  while (keys.length > 5000) keys.shift()
  await saveJson(seenPath(), { keys })
}

async function dirSizeBytes(dir) {
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

function sessionDirFor(cwd, sessionId) {
  return path.join(grokHome(), 'sessions', encodeURIComponent(cwd), sessionId)
}

function recordArchiveToMemory({ dest, reason, size, chatKey, cwd }) {
  const script = path.join(ROOT, 'archive-to-memory.mjs')
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
    child.on('error', () => resolve(false))
    child.on('close', (code) => {
      if (code === 0) {
        log('archive memory ok', out.trim().slice(0, 200))
        resolve(true)
      } else {
        log('archive memory fail', (err || out).trim().slice(0, 200))
        resolve(false)
      }
    })
  })
}

async function archiveSessionDir(sessionId, dir, reason, size, meta = {}) {
  const archRoot = path.join(grokHome(), 'sessions-archive')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(archRoot, `${sessionId.slice(0, 8)}-${stamp}`)
  try {
    await fs.mkdir(archRoot, { recursive: true })
    await fs.rename(dir, dest)
    log('session archived', dest, reason, size)
    void recordArchiveToMemory({
      dest,
      reason,
      size,
      chatKey: meta.chatKey,
      cwd: meta.cwd,
    })
  } catch (e) {
    log('archive fail', String(e.message || e).slice(0, 120))
  }
}

/**
 * sticky session:
 * - hard ≥20MB → archive + memory + new UUID
 * - soft ≥5MB → archive + memory + new UUID（与 dev198 对齐，避免孤儿 session）
 */
async function resolveStickySession(mapKey, cwd, meta = {}) {
  const hardMax = Number(
    process.env.GROK_SESSION_MAX_BYTES || 20 * 1024 * 1024,
  )
  const softMax = Number(
    process.env.GROK_SESSION_RESUME_MAX_BYTES || 5 * 1024 * 1024,
  )
  const map = await loadSessionMap()
  let sessionId = map[mapKey]?.sessionId
  if (!sessionId) {
    sessionId = randomUUID()
    map[mapKey] = { sessionId, createdAt: new Date().toISOString() }
    await saveSessionMap(map)
    return {
      sessionId,
      exists: false,
      size: 0,
      skipResume: true,
      rotated: false,
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
    await archiveSessionDir(sessionId, dir, 'hard_size', size, {
      chatKey: mapKey,
      cwd: meta.cwd || cwd,
    })
    const next = randomUUID()
    map[mapKey] = {
      sessionId: next,
      rotatedAt: new Date().toISOString(),
      reason: 'hard_size',
      prevSize: size,
    }
    await saveSessionMap(map)
    return {
      sessionId: next,
      exists: false,
      size: 0,
      skipResume: true,
      rotated: true,
    }
  }
  if (exists && size >= softMax) {
    log(
      'session soft archive+rotate',
      sessionId.slice(0, 8),
      `bytes=${size}`,
      `soft=${softMax}`,
    )
    await archiveSessionDir(sessionId, dir, 'soft_size', size, {
      chatKey: mapKey,
      cwd: meta.cwd || cwd,
    })
    const next = randomUUID()
    map[mapKey] = {
      sessionId: next,
      rotatedAt: new Date().toISOString(),
      reason: 'soft_size',
      prevSize: size,
    }
    await saveSessionMap(map)
    return {
      sessionId: next,
      exists: false,
      size: 0,
      skipResume: true,
      rotated: true,
    }
  }
  return {
    sessionId,
    exists,
    size,
    skipResume: !exists,
    rotated: false,
  }
}

function isMaxTurnsError(err) {
  const msg = String(err?.message || err || '')
  return (
    err?.isMaxTurns === true ||
    /max\s*turns?\s*reached/i.test(msg) ||
    /MaxTurnsExceeded/i.test(msg)
  )
}

/**
 * short = 轻聊（少轮次）；full = 执行/多步任务。
 * 宁可误进 full，也不要把「开干/继续」压成 8 轮导致 Max turns。
 */
function classifyMode(text, { hasMedia = false } = {}) {
  const t = String(text || '').trim()
  // 默认给足轮次：知识库/多文件任务 40 轮很容易顶满
  const fullTurns = Number(process.env.GROK_MAX_TURNS || 100)
  const shortTurns = Number(process.env.GROK_SHORT_MAX_TURNS || 24)

  if (hasMedia) return { mode: 'full', maxTurns: fullTurns }
  // 稍长必 full
  if (t.length > 80) return { mode: 'full', maxTurns: fullTurns }

  // 代码 / 路径 / 工作区
  if (
    /\/cwd\b|```|\.py\b|\.js\b|\.ts\b|\.sh\b|\.go\b|\.rs\b|\.mjs\b|\.md\b|~\/|\.env\b|\/home\//i.test(
      t,
    )
  ) {
    return { mode: 'full', maxTurns: fullTurns }
  }

  // 执行 / 方案 / 调研 / 阶段任务 —— 宁可误进 full
  if (
    /(改|修|写|跑|执行|部署|安装|删除|创建|重构|实现|排查|调试|优化|修复|配置|接入|整理|处理|落地|开干|开工|接着|继续|自检|验收|完成|推进|任务|知识库|存库|入库|方案|调研|推荐|设计|架构|插件|同步|api|API|p0|p1|p2|phase|fix|debug|implement|deploy|install|setup|build|refactor|文件|脚本|代码|服务|图片|附件|分析|火山|obsidian|Obsidian)/i.test(
      t,
    )
  ) {
    return { mode: 'full', maxTurns: fullTurns }
  }

  // 仅纯寒暄 / 单字确认走 short
  if (
    /^(你好|在吗|hi|hello|谢谢|好的|收到|嗯|ok|OK|嗯嗯|哈哈|ping|健康|status|👍|🙏)[\s!！.。]*$/i.test(
      t,
    )
  ) {
    return { mode: 'short', maxTurns: shortTurns }
  }

  // 默认 full（微信通道以执行为主）
  return { mode: 'full', maxTurns: fullTurns }
}

function parseCwdDirective(text, defaultCwd) {
  const lines = text.split(/\r?\n/)
  let cwd = defaultCwd
  let body = text
  const first = (lines[0] || '').trim()
  const m1 = first.match(/^(?:\/cwd|cwd:)\s*(.+)$/i)
  if (m1) {
    cwd = m1[1].trim().replace(/^~(?=$|\/)/, process.env.HOME || '')
    body = lines.slice(1).join('\n').trim()
  }
  const home = process.env.HOME || '/home'
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

function allowedRootsList() {
  const home = process.env.HOME || '/home'
  return (process.env.GROK_ALLOWED_ROOTS || home)
    .split(':')
    .map((p) => path.resolve(p.replace(/^~(?=$|\/)/, home)))
}

function buildAgentRules({ cwd }) {
  return [
    '你是通过微信 Bot 接入的 Grok Build **执行型**助手（不是只会给建议的聊天 bot）。',
    '【铁律】',
    '1. 用户要你做/改/修/跑时：必须自己调用工具动手，禁止只输出步骤。',
    '2. 先做后说：做完用中文简短汇报「做了什么 / 结果 / 路径」。',
    '3. 多步任务连续推进，不要每步问确认（微信无人值守）。',
    '4. 改完尽量自检；失败则分析再改。',
    '5. 不要输出 App Secret / token / 私钥 / .env 明文。',
    '6. 危险操作（rm -rf /、mkfs、dd 写盘）拒绝。',
    '7. 回复面向微信纯文本：结论在前、精炼；少空行；表格改短列表；禁用 Markdown 表格/代码块装饰。',
    `8. 当前 cwd=${cwd}；优先在此目录工作。`,
    '9. 会话可跨多轮；用户说「继续」接着做。',
    '10. 不要输出 render 组件、citation 标签、HTML 注释。',
    '11. 用户附件已落盘到 cwd/.inbound-media/；用 Read 读图/读文件。',
    '12. 回传文件：回复中写 `[[send-file:/绝对路径]]`（桥接上传发微信）；也可写 `本地路径: /abs`。',
  ].join('\n')
}

async function runGrok(prompt, { mapKey, cwd, hasMedia = false, progress = null }) {
  const bin = process.env.GROK_BIN || `${process.env.HOME}/.grok/bin/grok`
  const timeoutMs = Number(process.env.GROK_TIMEOUT_MS || 600_000)
  const { mode, maxTurns } = classifyMode(prompt, { hasMedia })
  const sticky = await resolveStickySession(mapKey, cwd, { cwd })
  let sessionId = sticky.sessionId
  const rules = buildAgentRules({ cwd })
  // max-turns 中断后续跑次数；默认 3 次，同 session 续跑不丢进度
  const continueRounds = Math.max(
    0,
    Number(process.env.GROK_CONTINUE_ON_MAX_TURNS ?? 3),
  )
  const continueTurns = Number(
    process.env.GROK_CONTINUE_MAX_TURNS ||
      Math.max(maxTurns, Number(process.env.GROK_MAX_TURNS || 100)),
  )
  const baseContinuePrompt =
    process.env.GROK_CONTINUE_PROMPT ||
    '【系统续跑】上一轮因 max turns 中断。请直接接着未完成工作推进，不要从零重做；完成后中文简短自检汇报（结论先行）。'

  function buildArgs(userPrompt, turns) {
    const args = [
      '-p',
      userPrompt,
      '--permission-mode',
      'bypassPermissions',
      '--always-approve',
      '--max-turns',
      String(turns),
      '--output-format',
      'plain',
      '--cwd',
      cwd,
      '--rules',
      rules,
      '--no-auto-update',
      '--allow',
      'Bash',
      '--allow',
      'Edit',
      '--allow',
      'Write',
      '--allow',
      'Read',
      '--deny',
      'Bash(rm -rf /*)',
      '--deny',
      'Bash(mkfs*)',
      '--deny',
      'Bash(dd if=*)',
    ]
    // full 带 EXTRA（如 --experimental-memory）；short 默认不加以免拖慢寒暄
    const extra = (process.env.GROK_EXTRA_ARGS || '').trim()
    if (extra && (mode === 'full' || envFlag('GROK_EXTRA_ARGS_ALWAYS', true))) {
      args.push(...extra.split(/\s+/).filter(Boolean))
    }
    // full 至少保证 experimental-memory
    if (
      mode === 'full' &&
      !args.includes('--experimental-memory') &&
      envFlag('GROK_FORCE_MEMORY_ON_FULL', true)
    ) {
      args.push('--experimental-memory')
    }
    return args
  }

  const env = {
    ...process.env,
    PATH: `${path.dirname(bin)}:${process.env.HOME}/.local/node/bin:${process.env.HOME}/.local/bin:${process.env.PATH || ''}`,
    http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
    https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '',
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || '',
    NO_PROXY:
      process.env.NO_PROXY ||
      'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,.weixin.qq.com',
    no_proxy:
      process.env.NO_PROXY ||
      'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,.weixin.qq.com',
    CI: '1',
    GROK_HEADLESS: '1',
  }

  function once(useArgs, wallMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, useArgs, {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const killHard = () => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }, 2000)
      }
      if (progress) {
        progress._kill = killHard
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        killHard()
        reject(new Error(`grok timeout after ${wallMs}ms`))
      }, wallMs)
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8')
        progress?.noteActivity?.()
      })
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8')
        progress?.noteActivity?.()
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) {
          resolve(stdout.trim() || '(grok 无文本输出，可能已完成工具操作)')
        } else {
          const errTail = stderr
            .slice(-1000)
            .replace(/Bearer\s+\S+/g, 'Bearer ***')
          const msg = `grok exit ${code}: ${errTail || stdout.slice(-400)}`
          const err = new Error(msg)
          if (
            /max\s*turns?\s*reached/i.test(msg) ||
            /max\s*turns?\s*reached/i.test(stdout)
          ) {
            err.isMaxTurns = true
            err.partialOutput = stdout.trim()
          }
          reject(err)
        }
      })
    })
  }

  async function mintNewSession(reason) {
    const map = await loadSessionMap()
    const next = randomUUID()
    map[mapKey] = {
      sessionId: next,
      rotatedAt: new Date().toISOString(),
      reason,
    }
    await saveSessionMap(map)
    log('session mint', next.slice(0, 8), reason)
    return next
  }

  /**
   * max-turns 时保留同一 session 自动续跑，避免 mint 新会话丢进度。
   */
  async function resumeContinue(sid, roundsLeft, seedPartial = '') {
    let lastErr = null
    let bestPartial = String(seedPartial || '').trim()
    for (let i = 0; i < roundsLeft; i++) {
      log(
        'auto-continue',
        `round=${i + 1}/${roundsLeft}`,
        `turns=${continueTurns}`,
        `sid=${sid.slice(0, 8)}`,
      )
      await progress?.continueRound?.(i + 1, roundsLeft)
      const contPrompt = bestPartial
        ? `${baseContinuePrompt}\n\n【上一轮未完成输出片段（供衔接，勿重复废话）】\n${bestPartial.slice(-2500)}`
        : baseContinuePrompt
      try {
        const out = await once(
          [...buildArgs(contPrompt, continueTurns), '-r', sid],
          timeoutMs,
        )
        // 拼接可读摘要：续跑结果优先
        if (bestPartial && out) {
          return `${out}\n\n（已自动续跑 ${i + 1} 轮完成）`
        }
        return out
      } catch (err) {
        lastErr = err
        if (err?.partialOutput) {
          bestPartial = String(err.partialOutput).trim() || bestPartial
        }
        log(
          'auto-continue fail',
          `round=${i + 1}`,
          String(err.message || err).slice(0, 160),
        )
        if (!isMaxTurnsError(err)) break
      }
    }
    // 续跑用尽：把已有部分结果回给用户，避免只报失败
    if (bestPartial) {
      log('auto-continue return partial', `chars=${bestPartial.length}`)
      return (
        bestPartial.slice(0, 3500) +
        '\n\n【提示】任务轮次用尽已自动续跑仍未收尾；请发「继续」让我接着干。'
      )
    }
    throw lastErr || new Error('auto-continue exhausted')
  }

  async function runOnceOnSession(sid, userPrompt, turns, { resume }) {
    const args = buildArgs(userPrompt, turns)
    if (resume) return once([...args, '-r', sid], timeoutMs)
    return once([...args, '-s', sid], timeoutMs)
  }

  log(
    'grok start',
    `mode=${mode}`,
    `turns=${maxTurns}`,
    `sid=${sessionId.slice(0, 8)}`,
    sticky.exists ? `size=${sticky.size}` : 'new',
    `continue_rounds=${continueRounds}`,
  )

  progress?.setMeta?.({
    mode,
    turns: maxTurns,
    sid: sessionId,
  })
  await progress?.start?.()

  try {
  // 1) 优先粘性 resume
  if (sticky.exists && !sticky.skipResume) {
    try {
      return await runOnceOnSession(sessionId, prompt, maxTurns, {
        resume: true,
      })
    } catch (err) {
      log('resume fail', String(err.message || err).slice(0, 160))
      // max-turns：同 session 续跑，禁止 mint 丢上下文
      if (isMaxTurnsError(err) && continueRounds > 0) {
        try {
          return await resumeContinue(
            sessionId,
            continueRounds,
            err.partialOutput || '',
          )
        } catch (contErr) {
          log(
            'auto-continue exhausted',
            String(contErr.message || contErr).slice(0, 160),
          )
          if (contErr?.partialOutput || err?.partialOutput) {
            return (
              String(contErr?.partialOutput || err.partialOutput).slice(0, 3500) +
              '\n\n【提示】轮次用尽；请发「继续」接着干。'
            )
          }
          throw contErr
        }
      }
      // 其它 resume 失败：换新 session 重跑用户原 prompt
      const next = await mintNewSession('resume_fail')
      sessionId = next
      try {
        return await runOnceOnSession(next, prompt, maxTurns, { resume: false })
      } catch (err2) {
        if (isMaxTurnsError(err2) && continueRounds > 0) {
          return resumeContinue(next, continueRounds, err2.partialOutput || '')
        }
        try {
          return await once(buildArgs(prompt, maxTurns), timeoutMs)
        } catch (err3) {
          throw err3
        }
      }
    }
  }

  // 2) 新会话 / 粘性但不 resume
  try {
    return await runOnceOnSession(sessionId, prompt, maxTurns, {
      resume: false,
    })
  } catch (err2) {
    log('create session fail', String(err2.message || err2).slice(0, 160))
    if (isMaxTurnsError(err2) && continueRounds > 0) {
      try {
        return await resumeContinue(
          sessionId,
          continueRounds,
          err2.partialOutput || '',
        )
      } catch (contErr) {
        if (contErr?.partialOutput || err2?.partialOutput) {
          return (
            String(contErr?.partialOutput || err2.partialOutput).slice(0, 3500) +
            '\n\n【提示】轮次用尽；请发「继续」接着干。'
          )
        }
        throw contErr
      }
    }
    if (/already in use/i.test(String(err2.message || ''))) {
      const next = await mintNewSession('create_already_in_use')
      try {
        return await runOnceOnSession(next, prompt, maxTurns, {
          resume: false,
        })
      } catch {
        /* fallthrough */
      }
    }
    return once(buildArgs(prompt, maxTurns), timeoutMs)
  }
  } finally {
    progress?.stop?.()
  }
}

async function sendTextChunks(cred, to, text, contextToken) {
  const cleaned = normalizeReply(text)
  for (const chunk of splitText(cleaned, 1800)) {
    await sendWechatText({
      baseUrl: cred.baseUrl,
      token: cred.token,
      to,
      text: chunk,
      contextToken,
    })
  }
}

async function sendReply(cred, to, text, contextToken) {
  await processOutboundReply({
    baseUrl: cred.baseUrl,
    token: cred.token,
    to,
    text: normalizeReply(text),
    contextToken,
    allowedRoots: allowedRootsList(),
    sendTextFn: (t) => sendTextChunks(cred, to, t, contextToken),
    log,
  })
}

/** @type {Set<{ progress: any, kill?: () => void }>} */
const activeJobs = new Set()
let queueChain = Promise.resolve()
/** tasks waiting or running in serial queue */
let queueLen = 0

function enqueue(taskFactory) {
  // ahead = tasks already in queue before this one
  const ahead = queueLen
  queueLen += 1
  queueChain = queueChain
    .then(async () => {
      try {
        await taskFactory(ahead)
      } finally {
        queueLen = Math.max(0, queueLen - 1)
      }
    })
    .catch((e) => {
      log('queue task error', String(e.message || e).slice(0, 200))
    })
  return queueChain
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

function envFlag(name, def = false) {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  return /^(1|true|yes|on)$/i.test(v)
}

async function handleInbound(cred, message, allowSet, { queueAhead = 0 } = {}) {
  const peerId = message.from_user_id?.trim()
  if (!peerId) return
  // message_type 2 often outbound/self — skip
  if (message.message_type === 2) return

  const seenKey = `${cred.accountId}:${message.message_id || message.seq || ''}:${peerId}:${message.create_time_ms || 0}`
  if (await hasSeen(seenKey)) return

  const rawText = extractWechatText(message)
  const mediaPresent = hasMediaItems(message)
  if (!rawText && !mediaPresent) return
  await markSeen(seenKey)

  if (allowSet.size > 0 && !allowSet.has(peerId)) {
    log('deny peer', peerId.slice(0, 12))
    await sendWechatText({
      baseUrl: cred.baseUrl,
      token: cred.token,
      to: peerId,
      text: '未授权的微信用户，请联系管理员把你的 userId 加入 ALLOW_USER_IDS。',
      contextToken: message.context_token,
    })
    return
  }

  const { kind: chatKind, roomId } = detectChatKind(message)
  const { forced, body: stripped, mentioned } = stripForcePrefix(rawText, {
    botName: process.env.BOT_DISPLAY_NAME || cred.name || '',
    botAccountId: cred.accountId || '',
  })
  const requireGroupPrefix = envFlag('REQUIRE_GROUP_PREFIX', true)

  if (
    !shouldProcessMessage({
      chatKind,
      forced,
      mentioned,
      hasMedia: mediaPresent,
      requireGroupPrefix,
    })
  ) {
    log(
      'group skip (need grok: / @bot)',
      roomId?.slice?.(0, 12) || 'group',
      peerId.slice(0, 12),
    )
    return
  }

  const defaultCwd = path.resolve(
    (process.env.GROK_CWD || path.join(ROOT, 'workspace')).replace(
      /^~(?=$|\/)/,
      process.env.HOME || '',
    ),
  )

  let cwd = defaultCwd
  let body = stripped || rawText
  try {
    const parsed = parseCwdDirective(body, defaultCwd)
    cwd = parsed.cwd
    body = parsed.body
  } catch (e) {
    await sendReply(cred, peerId, String(e.message || e), message.context_token)
    return
  }

  // download media into cwd
  let mediaResult = { files: [], errors: [] }
  if (mediaPresent) {
    try {
      mediaResult = await downloadInboundMedia({
        message,
        cwd,
        log,
      })
    } catch (err) {
      log('media batch fail', String(err.message || err).slice(0, 160))
      mediaResult = {
        files: [],
        errors: [String(err.message || err).slice(0, 160)],
      }
    }
  }

  if (!body && mediaResult.files.length) {
    body = '请查看附件。'
  }

  const bodyWithMedia = formatMediaPrompt(mediaResult, body)
  if (!bodyWithMedia) return

  if (/^(ping|健康|status)$/i.test((body || '').trim())) {
    await sendReply(
      cred,
      peerId,
      [
        'wechat-grok-bridge ok',
        `account=${cred.accountId}`,
        `cwd=${cwd}`,
        `chat=${chatKind}${roomId ? ` room=${roomId}` : ''}`,
        `media=${mediaResult.files.length}`,
        `timeout=${process.env.GROK_TIMEOUT_MS || 600000}ms`,
        `soft_archive=on soft_max=${process.env.GROK_SESSION_RESUME_MAX_BYTES || 5242880}`,
      ].join('\n'),
      message.context_token,
    )
    return
  }

  const mapKey = buildSessionKey({
    chatKind,
    peerId,
    roomId,
    cwd,
    groupSessionsPerUser: envFlag('GROUP_SESSIONS_PER_USER', true),
  })

  log(
    'inbound',
    chatKind,
    peerId.slice(0, 12),
    `media=${mediaResult.files.length}`,
    (body || '').slice(0, 80).replace(/\n/g, ' '),
  )

  const progress = createProgressReporter({
    log,
    sendText: (text) =>
      sendWechatText({
        baseUrl: cred.baseUrl,
        token: cred.token,
        to: peerId,
        text,
        contextToken: message.context_token,
      }),
  })

  if (queueAhead > 0) {
    await progress.queue(queueAhead)
  }

  await sendWechatText({
    baseUrl: cred.baseUrl,
    token: cred.token,
    to: peerId,
    text: mediaResult.files.length
      ? `收到（含 ${mediaResult.files.length} 个附件），Grok 处理中…`
      : '收到，Grok 处理中…',
    contextToken: message.context_token,
  }).catch(() => {})

  const job = { progress, kill: () => progress?._kill?.() }
  activeJobs.add(job)
  const t0 = Date.now()
  try {
    const reply = await runGrok(bodyWithMedia, {
      mapKey,
      cwd,
      hasMedia: mediaResult.files.length > 0,
      progress,
    })
    progress.stop()
    let out = reply
    // 长任务在结论后附耗时（不另起进度条）
    const elapsedMs = Date.now() - t0
    if (elapsedMs >= 120_000 && out && !/本次约\s*\d/.test(out)) {
      out = `${reply}\n\n（本次约 ${formatElapsed(elapsedMs)}）`
    }
    await sendReply(cred, peerId, out, message.context_token)
  } catch (err) {
    progress.stop()
    log('handle fail', String(err.message || err).slice(0, 200))
    let msg = `执行失败：${String(err.message || err).slice(0, 500)}`
    if (isMaxTurnsError(err)) {
      msg =
        (err.partialOutput
          ? String(err.partialOutput).slice(0, 2800) + '\n\n'
          : '') +
        '【提示】任务轮次用尽。请直接回「继续」，我会在同一会话接着干（已启用自动续跑）。'
    }
    await sendReply(cred, peerId, msg, message.context_token)
  } finally {
    activeJobs.delete(job)
    progress.stop()
  }
}

async function monitorLoop(cred, allowSet, signal) {
  let consecutiveFailures = 0
  while (!signal.aborted) {
    try {
      const getUpdatesBuf = await loadSyncBuf(cred.accountId)
      const response = await getWechatUpdates({
        baseUrl: cred.baseUrl,
        token: cred.token,
        getUpdatesBuf,
      })
      const isError =
        (response.ret !== undefined && response.ret !== 0) ||
        (response.errcode !== undefined && response.errcode !== 0)
      if (isError) {
        consecutiveFailures += 1
        log(
          'getupdates err',
          response.errmsg || response.errcode || response.ret,
          `fail=${consecutiveFailures}`,
        )
        await sleep(consecutiveFailures >= 3 ? 15_000 : 3_000, signal)
        if (consecutiveFailures >= 3) consecutiveFailures = 0
        continue
      }
      consecutiveFailures = 0
      if (response.get_updates_buf) {
        await saveSyncBuf(cred.accountId, response.get_updates_buf)
      }
      for (const message of response.msgs || []) {
        if (signal.aborted) break
        enqueue((ahead) => handleInbound(cred, message, allowSet, { queueAhead: ahead }))
      }
    } catch (error) {
      if (signal.aborted) return
      consecutiveFailures += 1
      log(
        'monitor error',
        String(error.message || error).slice(0, 160),
        `fail=${consecutiveFailures}`,
      )
      await sleep(consecutiveFailures >= 3 ? 15_000 : 3_000, signal)
      if (consecutiveFailures >= 3) consecutiveFailures = 0
    }
  }
}

async function main() {
  await loadEnvFile(path.join(ROOT, '.env'))
  await loadEnvFile(path.join(process.env.HOME || '', '.wechat-grok-bridge.env'))

  if (process.argv.includes('--check')) {
    const cred = await loadCredential()
    console.log(
      JSON.stringify(
        {
          ok: true,
          accountId: cred.accountId,
          baseUrl: cred.baseUrl,
          userId: cred.userId ? `${cred.userId.slice(0, 8)}…` : '',
          tokenLen: cred.token?.length || 0,
          features: {
            mediaInbound: true,
            mediaOutbound: true,
            softArchive: true,
            groupPolicy: true,
            wxStatus: process.env.WX_STATUS !== '0',
            experimentalMemory: !!(process.env.GROK_EXTRA_ARGS || '').includes(
              'experimental-memory',
            ),
          },
        },
        null,
        2,
      ),
    )
    return
  }

  const cred = await loadCredential()
  const allowSet = parseAllowList(cred.userId)
  if (allowSet.size === 0) {
    log('WARN ALLOW_USER_IDS empty — allowing all peers until configured')
  } else {
    log('allow users', allowSet.size)
  }

  await fs.mkdir(path.join(ROOT, 'workspace'), { recursive: true })
  await fs.mkdir(path.join(ROOT, 'data'), { recursive: true })
  await fs.mkdir(path.join(ROOT, 'logs'), { recursive: true })

  log(
    'bridge start',
    `account=${cred.accountId}`,
    `base=${cred.baseUrl}`,
    `media=in+out`,
    `soft_archive=on`,
    `proxy=${process.env.HTTPS_PROXY || process.env.ALL_PROXY || 'none'}`,
  )

  const ac = new AbortController()
  let shuttingDown = false
  async function gracefulShutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    log('shutdown', signal, `jobs=${activeJobs.size}`)
    const jobs = [...activeJobs]
    for (const job of jobs) {
      try {
        await job.progress?.interrupted?.(
          signal === 'SIGTERM' ? '服务停止/重启' : '中断',
        )
      } catch {
        /* ignore */
      }
      try {
        job.kill?.()
      } catch {
        /* ignore */
      }
    }
    ac.abort()
    // give WeChat send a moment
    setTimeout(() => process.exit(0), 1500)
  }
  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM')
  })

  log(
    'wx status',
    `enabled=${process.env.WX_STATUS ?? '1'}`,
    `heartbeat=${process.env.WX_STATUS_HEARTBEAT_SEC ?? 120}s`,
  )
  await monitorLoop(cred, allowSet, ac.signal)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
