#!/usr/bin/env node
/**
 * Minimal MCP server: wechat-bot
 * Tools: send_text, status
 *
 * Env (same as bridge):
 *   WECHAT_CREDENTIAL_SECRET, WECHAT_ACCOUNTS_FILE
 *   HTTP(S)_PROXY / NO_PROXY as needed
 *
 * Run: node mcp/wechat-bot.mjs
 * Grok config.toml:
 *   [mcp_servers.wechat-bot]
 *   command = "node"
 *   args = ["/home/USER/wechat-grok-bridge/mcp/wechat-bot.mjs"]
 *   enabled = true
 */
import { createHash, createDecipheriv } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendWechatText } from '../wechat-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

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
  } catch {
    /* ignore */
  }
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
  if (!secret || !filePath) throw new Error('WECHAT credentials missing')
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'))
  const accounts = Object.values(raw.accounts || {})
  if (!accounts.length) throw new Error('no wechat accounts')
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
  }
}

// Minimal JSON-RPC MCP over stdio (tools/list + tools/call)
let credPromise = null
function getCred() {
  if (!credPromise) credPromise = loadCredential()
  return credPromise
}

function ok(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}
function err(id, code, message) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

const TOOLS = [
  {
    name: 'send_text',
    description:
      'Send a plain text message to a WeChat user via iLink Bot (to_user_id).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'WeChat to_user_id (peer id)' },
        text: { type: 'string', description: 'Message body (plain text)' },
        context_token: {
          type: 'string',
          description: 'Optional context_token from last inbound',
        },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'status',
    description: 'Return bot account status (no secrets).',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function handleTool(name, args) {
  if (name === 'status') {
    const c = await getCred()
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              accountId: c.accountId,
              baseUrl: c.baseUrl,
              hasUserId: !!c.userId,
            },
            null,
            2,
          ),
        },
      ],
    }
  }
  if (name === 'send_text') {
    const c = await getCred()
    const to = String(args?.to || '').trim()
    const text = String(args?.text || '')
    if (!to || !text) throw new Error('to and text required')
    const clientId = await sendWechatText({
      baseUrl: c.baseUrl,
      token: c.token,
      to,
      text: text.slice(0, 4000),
      contextToken: args?.context_token,
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, clientId, to: to.slice(0, 12) }),
        },
      ],
    }
  }
  throw new Error(`unknown tool ${name}`)
}

async function main() {
  await loadEnvFile(path.join(ROOT, '.env'))
  await loadEnvFile(path.join(process.env.HOME || '', '.wechat-grok-bridge.env'))

  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', async (chunk) => {
    buf += chunk
    // Content-Length framing or newline JSON
    while (true) {
      let msg = null
      if (buf.startsWith('Content-Length:')) {
        const m = buf.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/)
        if (!m) break
        const len = Number(m[1])
        const start = m[0].length
        if (buf.length < start + len) break
        const raw = buf.slice(start, start + len)
        buf = buf.slice(start + len)
        try {
          msg = JSON.parse(raw)
        } catch {
          continue
        }
      } else {
        const nl = buf.indexOf('\n')
        if (nl < 0) break
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
      }
      if (!msg) continue
      const id = msg.id ?? null
      try {
        if (msg.method === 'initialize') {
          write(
            ok(id, {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'wechat-bot', version: '0.1.0' },
            }),
          )
        } else if (msg.method === 'notifications/initialized') {
          /* ack */
        } else if (msg.method === 'tools/list') {
          write(ok(id, { tools: TOOLS }))
        } else if (msg.method === 'tools/call') {
          const name = msg.params?.name
          const args = msg.params?.arguments || {}
          const result = await handleTool(name, args)
          write(ok(id, result))
        } else if (msg.method === 'ping') {
          write(ok(id, {}))
        } else if (id !== null) {
          write(err(id, -32601, `Method not found: ${msg.method}`))
        }
      } catch (e) {
        if (id !== null) {
          write(err(id, -32000, String(e.message || e).slice(0, 300)))
        }
      }
    }
  })
}

function write(s) {
  const body = typeof s === 'string' ? s : JSON.stringify(s)
  const payload = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
  process.stdout.write(payload)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
