#!/usr/bin/env node
/**
 * feishu-grok-bridge
 * 飞书 PersonalAgent Bot (WS 长连接) ↔ Grok Build headless（可执行工具 / 改文件 / 多轮改善）
 *
 * 流程：收 im.message.receive_v1 → 白名单 → grok -p（bypassPermissions）→ 回飞书
 * 凭据：复用 feishu-qr-login-module 的 AES 加密 accounts.json
 */
import { spawn } from 'node:child_process'
import { createHash, createDecipheriv, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Lark from '@larksuiteoapi/node-sdk'

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
  const secret = process.env.FEISHU_CREDENTIAL_SECRET
  const filePath = process.env.FEISHU_ACCOUNTS_FILE
  if (!secret || secret.length < 32) {
    throw new Error('FEISHU_CREDENTIAL_SECRET missing/too short')
  }
  if (!filePath) throw new Error('FEISHU_ACCOUNTS_FILE missing')
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'))
  const accounts = Object.values(raw.accounts || {})
  if (!accounts.length) throw new Error('no accounts in store — scan QR first')
  accounts.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
  const acc = accounts[0]
  return {
    appId: acc.appId,
    appSecret: decryptSecret(secret, acc.appSecret),
    brand: acc.brand || 'feishu',
    openId: acc.openId || '',
    savedAt: acc.savedAt,
  }
}

function parseAllowList(credentialOpenId) {
  const extra = (process.env.ALLOW_OPEN_IDS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const set = new Set(extra)
  if (credentialOpenId) set.add(credentialOpenId)
  return set
}

function extractText(message) {
  const msgType = message?.message_type || message?.msg_type
  const raw = message?.content
  if (!raw) return ''
  let content
  try {
    content = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return typeof raw === 'string' ? raw : ''
  }
  if (msgType === 'text' || content.text) return String(content.text || '').trim()
  if (msgType === 'post' && content) {
    const parts = []
    const walk = (nodes) => {
      if (!Array.isArray(nodes)) return
      for (const row of nodes) {
        if (Array.isArray(row)) walk(row)
        else if (row?.tag === 'text' && row.text) parts.push(row.text)
        else if (row?.tag === 'a' && row.text) parts.push(row.text)
      }
    }
    if (content.content) walk(content.content)
    else if (content.zh_cn?.content) walk(content.zh_cn.content)
    return parts.join('').trim()
  }
  return ''
}

function splitText(text, limit = 3000) {
  const chunks = []
  let rest = String(text || '')
  while (rest.length > limit) {
    const slice = rest.slice(0, limit)
    const breakAt = Math.max(
      slice.lastIndexOf('\n\n'),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf(' '),
    )
    const cut = breakAt > 800 ? breakAt : limit
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.length ? chunks : ['(空回复)']
}

/** 表格行粗判：| a | b | */
function looksLikeTableRow(line) {
  const t = String(line || '').trim()
  if (!t.includes('|')) return false
  // 至少两段单元格
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length >= 2
}

/** | --- | :---: | */
function looksLikeTableSep(line) {
  const t = String(line || '').trim()
  if (!t.includes('|') || !t.includes('-')) return false
  return /^[\s|:\-]+$/.test(t)
}

/**
 * 把 GFM 表格收成等宽代码块，避免飞书卡片 markdown 表格错乱。
 */
function convertMarkdownTables(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const row = lines[i]
    const next = lines[i + 1]
    if (looksLikeTableRow(row) && looksLikeTableSep(next)) {
      const table = []
      while (i < lines.length && looksLikeTableRow(lines[i])) {
        table.push(lines[i])
        i += 1
      }
      const pretty = table
        .filter((l) => !looksLikeTableSep(l))
        .map((l) =>
          l
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim())
            .join('  ·  '),
        )
      out.push('```')
      out.push(...pretty)
      out.push('```')
      continue
    }
    out.push(row)
    i += 1
  }
  return out.join('\n')
}

/**
 * 清洗成飞书卡片 markdown 友好格式。
 * 参考：飞书卡片不支持 #/##/### 一二三级标题。
 */
function normalizeForFeishuCard(text) {
  let s = String(text || '')
  // 若上游把换行写成字面量 \n，还原
  if (s.includes('\\n') && !s.includes('\n')) {
    s = s.replace(/\\n/g, '\n')
  }
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // 去掉首尾多余空白、压缩 3+ 空行
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // # ## ### → 加粗（####/##### 保留）
  s = s.replace(/^#{1,3}\s+(.+)$/gm, (_, title) => `**${title.trim()}**`)
  // 去掉单独一行的 HTML 注释 / 渲染组件残片
  s = s.replace(/^<!--[\s\S]*?-->$/gm, '')
  s = s.replace(/^\s*display\s+render_inline_citation[\s\S]*$/gim, '')
  s = convertMarkdownTables(s)
  // 再次压缩空行
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s || '(空回复)'
}

/**
 * 短状态消息：纯文本更轻；长回复走交互卡片 markdown。
 */
function preferCard(text) {
  const s = String(text || '')
  if (s.length < 80 && !/[`|*#\n]/.test(s)) return false
  // 含 markdown / 多行 / 较长 → 卡片
  return s.length >= 60 || /\n/.test(s) || /```|^\s*#{1,6}\s|\*\*|^\s*[-*]\s|^\s*\d+\.\s/m.test(s)
}

function buildStatusCard({ title, body, template = 'blue' }) {
  const content = normalizeForFeishuCard(body)
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: String(title || 'Grok').slice(0, 50),
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: content.slice(0, 10000),
      },
    ],
  }
}

function sessionIdForChat(chatId) {
  const sessionSeed = createHash('sha256').update(`feishu:${chatId}`).digest('hex')
  return [
    sessionSeed.slice(0, 8),
    sessionSeed.slice(8, 12),
    `4${sessionSeed.slice(13, 16)}`,
    `${((parseInt(sessionSeed.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, '0')}${sessionSeed.slice(18, 20)}`,
    sessionSeed.slice(20, 32),
  ].join('-')
}

function grokHome() {
  return process.env.GROK_HOME || path.join(process.env.HOME || '', '.grok')
}

function sessionDirFor(cwd, sessionId) {
  return path.join(grokHome(), 'sessions', encodeURIComponent(cwd), sessionId)
}

function sessionMapPath() {
  return (
    process.env.GROK_SESSION_MAP ||
    path.join(ROOT, 'workspace', '.session-map.json')
  )
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

async function loadSessionMap() {
  try {
    return JSON.parse(await fs.readFile(sessionMapPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function saveSessionMap(map) {
  const p = sessionMapPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
}

/**
 * 归档目录 → Grok 记忆系统（MEMORY.md / sessions 日志 / INDEX）。
 * 失败只打日志，不阻断主流程。
 */
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
    // 写入记忆系统，保证下次可召回
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

/**
 * 解析/轮转 sticky session。
 * - 默认沿用 map 或确定性 id
 * - 目录 ≥ hardMax(20MB) → 归档 + 记忆 + 换新 UUID
 * - 目录 ≥ softMax(5MB) → 同样归档 + 记忆 + 换新 UUID（不再只跳过 resume）
 * - 注意：不是「空闲 10 分钟切 session」；GROK_TIMEOUT_MS 是单次进程墙钟超时
 */
async function resolveStickySession(chatId, cwd) {
  const hardMax = Number(
    process.env.GROK_SESSION_MAX_BYTES || 20 * 1024 * 1024,
  )
  const softMax = Number(
    process.env.GROK_SESSION_RESUME_MAX_BYTES || 5 * 1024 * 1024,
  )
  const key = `${chatId}:${cwd}`
  const map = await loadSessionMap()
  let sessionId = map[key]?.sessionId || sessionIdForChat(key)
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
      chatKey: key,
      cwd,
    })
    sessionId = randomUUID()
    map[key] = {
      sessionId,
      rotatedAt: new Date().toISOString(),
      reason: 'hard_max',
      prevSize: size,
    }
    await saveSessionMap(map)
    return { sessionId, exists: false, size: 0, rotated: true, skipResume: true }
  }

  if (exists && size >= softMax) {
    // soft 也归档进记忆，避免孤儿 session 无法召回
    log(
      'session soft archive+rotate',
      sessionId.slice(0, 8),
      `bytes=${size}`,
      `soft=${softMax}`,
    )
    await archiveSessionDir(sessionId, dir, 'soft_max', size, {
      chatKey: key,
      cwd,
    })
    sessionId = randomUUID()
    map[key] = {
      sessionId,
      rotatedAt: new Date().toISOString(),
      reason: 'soft_max',
      prevSize: size,
    }
    await saveSessionMap(map)
    return { sessionId, exists: false, size: 0, rotated: true, skipResume: true }
  }

  if (!map[key]?.sessionId) {
    map[key] = { sessionId, updatedAt: new Date().toISOString() }
    await saveSessionMap(map)
  }
  return { sessionId, exists, size, rotated: false, skipResume: false }
}

/**
 * 简单问答 → 短路径；改文件/跑命令/长文 → 全量执行型。
 * 注意：与 GROK_TIMEOUT_MS 无关（那是单次进程墙钟超时）。
 */
function classifyMode(text) {
  const t = String(text || '').trim()
  const fullTurns = Number(process.env.GROK_MAX_TURNS || 40)
  const shortTurns = Number(process.env.GROK_SHORT_MAX_TURNS || 8)
  if (t.length > 180) return { mode: 'full', maxTurns: fullTurns }
  if (/\/cwd\b|```|\.py\b|\.js\b|\.ts\b|\.sh\b|\.go\b|\.rs\b|\.mjs\b/i.test(t)) {
    return { mode: 'full', maxTurns: fullTurns }
  }
  if (
    /(改|修|写|跑|执行|部署|安装|删除|创建|重构|实现|排查|调试|fix|debug|implement|deploy|install|refactor|文件|脚本|代码|服务|进程|npm\s|pip\s|git\s)/i.test(
      t,
    )
  ) {
    return { mode: 'full', maxTurns: fullTurns }
  }
  if (
    t.length <= 100 ||
    /[?？]$|^(你好|在吗|hi|hello|谢谢|好的|收到|怎么样|如何|什么|为什么|为何)/i.test(
      t,
    )
  ) {
    return { mode: 'short', maxTurns: shortTurns }
  }
  return { mode: 'full', maxTurns: fullTurns }
}

function isAlreadyInUseError(err) {
  const m = String(err?.message || err || '')
  return /already in use/i.test(m)
}

function isTimeoutError(err) {
  const m = String(err?.message || err || '')
  return /timeout after/i.test(m)
}

/** 解析消息中的工作区指令：/cwd /path 或 首行 cwd:/path */
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

  // 安全：禁止跳到敏感路径外的绝对任意？允许 $HOME 下；也允许 absolute under home
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

function buildAgentRules({ cwd }) {
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

async function runGrok(prompt, { chatId, cwd }) {
  const bin = process.env.GROK_BIN || `${process.env.HOME}/.grok/bin/grok`
  // 单次任务墙钟超时（默认 10min）；不是「空闲 10min 切 session」
  // 单次任务墙钟超时（默认 10min）。不是「空闲 10min 归档 session」。
  const timeoutMs = Number(process.env.GROK_TIMEOUT_MS || 600_000)
  const { mode, maxTurns } = classifyMode(prompt)
  const sticky = await resolveStickySession(chatId, cwd)
  const sessionId = sticky.sessionId
  const rules = buildAgentRules({ cwd })

  const baseArgs = [
    '-p',
    prompt,
    '--permission-mode',
    'bypassPermissions',
    '--always-approve',
    '--max-turns',
    String(maxTurns),
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

  // 全量模式才挂 GROK_EXTRA_ARGS（如 --experimental-memory）；短路径减负
  const extra = (process.env.GROK_EXTRA_ARGS || '').trim()
  if (mode === 'full' && extra) {
    baseArgs.push(...extra.split(/\s+/).filter(Boolean))
  }

  const env = {
    ...process.env,
    PATH: `${path.dirname(bin)}:${process.env.HOME}/.local/node/bin:${process.env.HOME}/.local/bin:${process.env.PATH || ''}`,
    http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
    https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '',
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || '',
    NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,.feishu.cn',
    no_proxy: process.env.NO_PROXY || 'localhost,127.0.0.1,.feishu.cn',
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
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        killHard()
        reject(new Error(`grok timeout after ${wallMs}ms`))
      }, wallMs)

      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8')
      })
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8')
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
          const errTail = stderr.slice(-1000).replace(/Bearer\s+\S+/g, 'Bearer ***')
          reject(new Error(`grok exit ${code}: ${errTail || stdout.slice(-400)}`))
        }
      })
    })
  }

  async function mintNewSession(reason) {
    const key = `${chatId}:${cwd}`
    const map = await loadSessionMap()
    const next = randomUUID()
    map[key] = {
      sessionId: next,
      rotatedAt: new Date().toISOString(),
      reason,
    }
    await saveSessionMap(map)
    log('session mint', next.slice(0, 8), reason)
    return next
  }

  log(
    'grok start',
    `mode=${mode}`,
    `turns=${maxTurns}`,
    `sid=${sessionId.slice(0, 8)}`,
    sticky.exists ? `size=${sticky.size}` : 'new',
    sticky.rotated ? 'rotated' : '',
  )

  // 1) 小 session 才 resume；失败立刻换新 id（already in use / miss / timeout）
  //    大 session 已在 resolveStickySession 跳过 -r，避免加载卡死
  if (sticky.exists && !sticky.skipResume) {
    try {
      return await once([...baseArgs, '-r', sessionId], timeoutMs)
    } catch (err) {
      const why = isAlreadyInUseError(err)
        ? 'already_in_use'
        : isTimeoutError(err)
          ? 'resume_timeout'
          : 'resume_miss'
      log(
        'grok resume fail fast',
        sessionId.slice(0, 8),
        why,
        String(err.message || err).slice(0, 160),
      )
      const next = await mintNewSession(why)
      try {
        return await once([...baseArgs, '-s', next], timeoutMs)
      } catch (err2) {
        log('grok -s after rotate fail', String(err2.message || err2).slice(0, 160))
        return once(baseArgs, timeoutMs)
      }
    }
  }

  // 2) 新 session：创建 sticky 并执行（完整任务超时；冲突则换 id 再跑）
  try {
    return await once([...baseArgs, '-s', sessionId], timeoutMs)
  } catch (err2) {
    log('grok -s failed', String(err2.message || err2).slice(0, 200))
    if (isAlreadyInUseError(err2)) {
      const next = await mintNewSession('create_already_in_use')
      try {
        return await once([...baseArgs, '-s', next], timeoutMs)
      } catch (err3) {
        log('grok -s mint fail', String(err3.message || err3).slice(0, 160))
      }
    }
    // 3) 无 session 单发
    return once(baseArgs, timeoutMs)
  }
}

async function sendText(client, receiveId, text, receiveIdType = 'chat_id') {
  // 纯文本也做基础清洗，避免字面量 \n 和过多空行
  const cleaned = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  for (const chunk of splitText(cleaned, 3500)) {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
        uuid: randomUUID().slice(0, 50),
      },
    })
    if (res?.code !== 0) {
      throw new Error(`feishu send failed: ${res?.code} ${res?.msg}`)
    }
  }
}

/**
 * 发送飞书交互卡片（markdown 元素）。失败时回落纯文本。
 * @param {'blue'|'wathet'|'green'|'orange'|'red'|'purple'|'turquoise'|'carmine'|'violet'|'yellow'|'indigo'|'grey'} template
 */
async function sendCard(
  client,
  receiveId,
  { title, body, template = 'blue' },
  receiveIdType = 'chat_id',
) {
  const md = normalizeForFeishuCard(body)
  const chunks = splitText(md, 3800)
  for (let i = 0; i < chunks.length; i++) {
    const partTitle =
      chunks.length > 1 ? `${title}（${i + 1}/${chunks.length}）` : title
    const card = buildStatusCard({
      title: partTitle,
      body: chunks[i],
      template,
    })
    try {
      const res = await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
          uuid: randomUUID().slice(0, 50),
        },
      })
      if (res?.code !== 0) {
        throw new Error(`card ${res?.code} ${res?.msg}`)
      }
    } catch (err) {
      log('sendCard fallback text', String(err.message || err).slice(0, 160))
      await sendText(
        client,
        receiveId,
        `${partTitle}\n\n${chunks[i]}`,
        receiveIdType,
      )
    }
  }
}

/** 智能发送：长文/markdown → 卡片；短句 → 文本 */
async function sendReply(
  client,
  receiveId,
  text,
  { title = 'Grok', template = 'blue', forceCard = false, forceText = false } = {},
  receiveIdType = 'chat_id',
) {
  if (forceText || (!forceCard && !preferCard(text))) {
    await sendText(client, receiveId, text, receiveIdType)
    return
  }
  await sendCard(
    client,
    receiveId,
    { title, body: text, template },
    receiveIdType,
  )
}

let chain = Promise.resolve()
function enqueue(task) {
  chain = chain.then(task, task)
  return chain
}

const seenMessageIds = new Set()
function remember(id) {
  if (!id) return false
  if (seenMessageIds.has(id)) return true
  seenMessageIds.add(id)
  if (seenMessageIds.size > 2000) {
    const first = seenMessageIds.values().next().value
    seenMessageIds.delete(first)
  }
  return false
}

async function ensureWorkspaceScaffold(cwd) {
  await fs.mkdir(cwd, { recursive: true })
  const agents = path.join(cwd, 'AGENTS.md')
  try {
    await fs.access(agents)
  } catch {
    await fs.writeFile(
      agents,
      `# AGENTS.md — 飞书 Grok 执行约定

- 你是执行型 agent：用户从飞书下达任务，你必须自己跑命令、改文件、验证。
- 默认中文简短汇报。
- 不要泄露密钥。
- 高危破坏性操作拒绝。
- 任务完成后在 FEISHU_TASKLOG.md 追加一行摘要（时间 + 做了什么）。
`,
      'utf8',
    )
  }
}

async function main() {
  await loadEnvFile(path.join(ROOT, '.env'))
  const checkOnly = process.argv.includes('--check')

  const defaultCwd = path.resolve(
    (process.env.GROK_CWD || path.join(ROOT, 'workspace')).replace(
      /^~(?=$|\/)/,
      process.env.HOME || '',
    ),
  )

  const cred = await loadCredential()
  const allow = parseAllowList(cred.openId)
  log(
    'credential loaded',
    `appId=${cred.appId}`,
    `openId=${cred.openId || '(none)'}`,
    `allow=${allow.size}`,
    `defaultCwd=${defaultCwd}`,
  )

  const domain = cred.brand === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
  const client = new Lark.Client({
    appId: cred.appId,
    appSecret: cred.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
  })

  try {
    const tokenRes = await client.auth.tenantAccessToken.internal({
      data: { app_id: cred.appId, app_secret: cred.appSecret },
    })
    log(
      'tenant_token',
      tokenRes?.code === 0 ? 'ok' : `code=${tokenRes?.code} msg=${tokenRes?.msg}`,
    )
  } catch (e) {
    log('tenant_token error', String(e.message || e).slice(0, 200))
  }

  if (checkOnly) {
    log('check ok')
    process.exit(0)
  }

  await ensureWorkspaceScaffold(defaultCwd)

  const dispatcher = new Lark.EventDispatcher({
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    loggerLevel: Lark.LoggerLevel.info,
  }).register({
    'im.message.receive_v1': async (data) => {
      try {
        const message = data?.message || data
        const sender = data?.sender || {}
        const messageId = message?.message_id
        const chatId = message?.chat_id
        const chatType = message?.chat_type
        const senderOpenId =
          sender?.sender_id?.open_id ||
          sender?.id?.open_id ||
          sender?.open_id ||
          ''
        const senderType = sender?.sender_type

        if (remember(messageId)) {
          log('dedupe', messageId)
          return 'ok'
        }
        if (senderType === 'app') return 'ok'

        if (allow.size && senderOpenId && !allow.has(senderOpenId)) {
          log('deny openId', senderOpenId)
          if (chatId) {
            await sendText(
              client,
              chatId,
              '未授权：此 Bot 仅对扫码授权用户开放。',
            ).catch(() => {})
          }
          return 'ok'
        }

        const text = extractText(message)
        if (!text) {
          if (chatId) await sendText(client, chatId, '暂只支持文本消息。').catch(() => {})
          return 'ok'
        }

        if (chatType === 'group') {
          const mentions = message?.mentions
          const hasMention = Array.isArray(mentions) && mentions.length > 0
          const forced = /^(?:\/grok|@grok|grok[:：]\s*|\/cwd\b)/i.test(text)
          if (!hasMention && !forced) {
            log('group skip (no mention)', chatId)
            return 'ok'
          }
        }

        const cleaned = text
          .replace(/@_user_\d+/g, '')
          .replace(/^(?:\/grok|@grok|grok[:：]\s*)/i, '')
          .trim()

        // 帮助
        if (/^(help|帮助|\/help)$/i.test(cleaned)) {
          await sendCard(client, chatId, {
            title: '🛠 执行型 Grok',
            template: 'blue',
            body: [
              '可改文件 / 跑命令，直接下任务即可。',
              '',
              '**示例**',
              '- 在 workspace 写一个 hello.py 并运行',
              '- 把 XX 脚本改成支持参数并自测',
              '',
              '**指定工作目录**',
              '```',
              '/cwd ~/某项目',
              '（下一行写任务）',
              '```',
              '',
              `默认 cwd：\`${defaultCwd}\``,
              `max_turns=${process.env.GROK_MAX_TURNS || 40}（短问 ${process.env.GROK_SHORT_MAX_TURNS || 8}）`,
              `timeout=${process.env.GROK_TIMEOUT_MS || 600000}ms（单次任务墙钟，非空闲切 session）`,
              `session soft/hard=${process.env.GROK_SESSION_RESUME_MAX_BYTES || 5242880}/${process.env.GROK_SESSION_MAX_BYTES || 20971520} bytes`,
            ].join('\n'),
          })
          return 'ok'
        }

        let cwd = defaultCwd
        let body = cleaned
        try {
          const parsed = parseCwdDirective(cleaned, defaultCwd)
          cwd = parsed.cwd
          body = parsed.body
        } catch (e) {
          await sendCard(client, chatId, {
            title: '⚠️ 参数错误',
            template: 'orange',
            body: String(e.message || e),
          }).catch(() =>
            sendText(client, chatId, `⚠️ ${e.message}`),
          )
          return 'ok'
        }

        const modeHint = classifyMode(body)
        log(
          'inbound',
          chatType || '?',
          chatId?.slice(0, 12),
          'cwd=',
          cwd,
          'len=',
          body.length,
          `mode=${modeHint.mode}`,
          `turns=${modeHint.maxTurns}`,
        )

        enqueue(async () => {
          const started = Date.now()
          let beat = 0
          const heartbeat = setInterval(() => {
            beat += 1
            const min = Math.round((Date.now() - started) / 60000)
            // 心跳保持轻量纯文本，避免刷屏卡片
            sendText(
              client,
              chatId,
              `⏳ 仍在执行… ${min} 分钟（心跳 #${beat}）`,
            ).catch(() => {})
          }, 60_000)

          try {
            await ensureWorkspaceScaffold(cwd)
            const taskPreview =
              body.slice(0, 280) + (body.length > 280 ? '…' : '')
            await sendCard(client, chatId, {
              title: '🚀 开始执行',
              template: 'wathet',
              body: [
                `**cwd** \`${cwd}\``,
                `**模式** ${modeHint.mode} · max_turns=${modeHint.maxTurns}`,
                '',
                '**任务**',
                taskPreview,
              ].join('\n'),
            }).catch(() =>
              sendText(
                client,
                chatId,
                `🚀 开始执行\ncwd: ${cwd}\nmode: ${modeHint.mode}/${modeHint.maxTurns}\n任务: ${taskPreview}`,
              ),
            )

            const reply = await runGrok(body, { chatId, cwd })
            const sec = Math.round((Date.now() - started) / 1000)
            await sendReply(client, chatId, reply, {
              title: `✅ 完成 · ${sec}s`,
              template: 'green',
              forceCard: true,
            })
            log('outbound ok', 'chars=', reply.length, 'sec=', sec)
          } catch (err) {
            const msg = String(err.message || err).slice(0, 800)
            log('handle error', msg)
            await sendCard(client, chatId, {
              title: '⚠️ 执行失败',
              template: 'red',
              body: msg,
            }).catch(() => sendText(client, chatId, `⚠️ 执行失败：${msg}`))
          } finally {
            clearInterval(heartbeat)
          }
        })
      } catch (err) {
        log('handler crash', String(err.message || err).slice(0, 300))
      }
      return 'ok'
    },
  })

  const ws = new Lark.WSClient({
    appId: cred.appId,
    appSecret: cred.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
  })

  log('starting WS long connection…')
  await ws.start({ eventDispatcher: dispatcher })
  log('WS started — agent mode ready')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
