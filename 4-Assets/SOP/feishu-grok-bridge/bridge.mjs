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
  let rest = text
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
    '7. 回复适合 IM：结论在前，细节精炼；代码块可保留。',
    `8. 当前工作目录 cwd=${cwd}；优先在此目录及子目录工作。需要其它目录先说明。`,
    '9. 会话可跨多轮：用户说「继续/再改善/还有问题」时接着改，不要重头空谈。',
  ].join('\n')
}

function runGrok(prompt, { chatId, cwd }) {
  const bin = process.env.GROK_BIN || `${process.env.HOME}/.grok/bin/grok`
  const maxTurns = String(process.env.GROK_MAX_TURNS || '40')
  const timeoutMs = Number(process.env.GROK_TIMEOUT_MS || 1_800_000)
  const sessionId = sessionIdForChat(`${chatId}:${cwd}`)
  const rules = buildAgentRules({ cwd })

  const baseArgs = [
    '-p',
    prompt,
    '--permission-mode',
    'bypassPermissions',
    '--always-approve',
    '--max-turns',
    maxTurns,
    '--output-format',
    'plain',
    '--cwd',
    cwd,
    '--rules',
    rules,
    '--no-auto-update',
    // 明确放开写/跑；仍可用 deny 挡高危
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

  // 可选额外参数（空格分隔）
  const extra = (process.env.GROK_EXTRA_ARGS || '').trim()
  if (extra) {
    // 简单 split，不支持复杂引号
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
    // headless 无人值守
    CI: '1',
    GROK_HEADLESS: '1',
  }

  function once(useArgs, onProgress) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, useArgs, {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let lastProgressAt = Date.now()
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`grok timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      const bump = (chunk, stream) => {
        if (stream === 'out') stdout += chunk
        else stderr += chunk
        // 粗粒度进度：stderr/stdout 有工具日志时回调
        const now = Date.now()
        if (onProgress && now - lastProgressAt > 25_000) {
          lastProgressAt = now
          const hint = (stderr + stdout).slice(-200).replace(/\s+/g, ' ').slice(0, 120)
          onProgress(hint)
        }
      }

      child.stdout.on('data', (d) => bump(d.toString('utf8'), 'out'))
      child.stderr.on('data', (d) => bump(d.toString('utf8'), 'err'))
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout.trim() || '(grok 无文本输出，可能已完成工具操作)')
        else {
          const errTail = stderr.slice(-1000).replace(/Bearer\s+\S+/g, 'Bearer ***')
          reject(new Error(`grok exit ${code}: ${errTail || stdout.slice(-400)}`))
        }
      })
    })
  }

  const onProgress = null // 由外层 heartbeat 负责

  return once([...baseArgs, '-r', sessionId], onProgress).catch(async () => {
    log('grok resume miss, try create', sessionId.slice(0, 8))
    try {
      return await once([...baseArgs, '-s', sessionId], onProgress)
    } catch (err2) {
      log('grok -s failed, plain single', String(err2.message || err2).slice(0, 200))
      return once(baseArgs, onProgress)
    }
  })
}

async function sendText(client, receiveId, text, receiveIdType = 'chat_id') {
  for (const chunk of splitText(text, 3000)) {
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
          await sendText(
            client,
            chatId,
            [
              '🛠 执行型 Grok（可改文件/跑命令）',
              '',
              '直接下任务即可，例如：',
              '• 在 workspace 写一个 hello.py 并运行',
              '• 把 XX 脚本改成支持参数并自测',
              '',
              '指定工作目录：',
              '  /cwd ~/某项目',
              '  （下一行写任务）',
              '',
              `默认 cwd：${defaultCwd}`,
              `max_turns=${process.env.GROK_MAX_TURNS || 40} timeout=${process.env.GROK_TIMEOUT_MS || 1800000}ms`,
            ].join('\n'),
          )
          return 'ok'
        }

        let cwd = defaultCwd
        let body = cleaned
        try {
          const parsed = parseCwdDirective(cleaned, defaultCwd)
          cwd = parsed.cwd
          body = parsed.body
        } catch (e) {
          await sendText(client, chatId, `⚠️ ${e.message}`)
          return 'ok'
        }

        log('inbound', chatType || '?', chatId?.slice(0, 12), 'cwd=', cwd, 'len=', body.length)

        enqueue(async () => {
          const started = Date.now()
          let beat = 0
          const heartbeat = setInterval(() => {
            beat += 1
            const min = Math.round((Date.now() - started) / 60000)
            sendText(
              client,
              chatId,
              `⏳ 仍在执行中… ${min} 分钟（第 ${beat} 次心跳）。Grok 正在用工具改/跑，请稍候。`,
            ).catch(() => {})
          }, 60_000)

          try {
            await ensureWorkspaceScaffold(cwd)
            await sendText(
              client,
              chatId,
              `🚀 开始执行\ncwd: ${cwd}\n任务: ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}`,
            ).catch(() => {})

            const reply = await runGrok(body, { chatId, cwd })
            const sec = Math.round((Date.now() - started) / 1000)
            await sendText(
              client,
              chatId,
              `✅ 完成（${sec}s）\n\n${reply}`,
            )
            log('outbound ok', 'chars=', reply.length, 'sec=', sec)
          } catch (err) {
            const msg = String(err.message || err).slice(0, 800)
            log('handle error', msg)
            await sendText(client, chatId, `⚠️ 执行失败：${msg}`).catch(() => {})
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
