#!/usr/bin/env node
/**
 * 川哥授权：重启 bridge 后发微信心跳。
 * 独立进程执行，避免与当前通道同生共死时丢心跳。
 *
 * Usage:
 *   node scripts/restart-and-heartbeat.mjs
 *   node scripts/restart-and-heartbeat.mjs --no-restart   # 只心跳
 *   PEER=xxx node scripts/restart-and-heartbeat.mjs
 */
import { spawn, execFile } from 'node:child_process'
import { createHash, createDecipheriv } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendWechatText } from '../wechat-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const UNIT = process.env.BRIDGE_UNIT || 'wechat-grok-bridge'
const DEFAULT_PEER =
  process.env.PEER ||
  process.env.HEARTBEAT_PEER ||
  'o9cq808cMu_IWiueFB-jwkI3ekBQ@im.wechat'

const noRestart = process.argv.includes('--no-restart')
const logFile = path.join(ROOT, 'logs', 'restart-heartbeat.log')

async function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  try {
    await fs.appendFile(logFile, line)
  } catch {
    /* ignore */
  }
  process.stdout.write(line)
}

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

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 60_000, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        err: err ? String(err.message || err) : '',
      })
    })
  })
}

async function systemctlUser(...args) {
  return run('systemctl', ['--user', ...args])
}

async function waitActive(maxMs = 45_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const r = await systemctlUser('is-active', UNIT)
    const state = (r.stdout || r.stderr || '').trim()
    if (state === 'active') return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}

async function main() {
  await loadEnvFile(path.join(ROOT, '.env'))
  await loadEnvFile(path.join(process.env.HOME || '', '.wechat-grok-bridge.env'))
  // 微信 API 直连
  if (!process.env.NO_PROXY) {
    process.env.NO_PROXY =
      'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,.weixin.qq.com'
  }

  await log('start', noRestart ? 'heartbeat-only' : 'restart+heartbeat', `unit=${UNIT}`)

  if (!noRestart) {
    // 给当前通道一点时间把本回合回复发出去
    await log('sleep 4s before restart (allow current reply flush)')
    await new Promise((r) => setTimeout(r, 4000))

    await log('restarting unit…')
    const stop = await systemctlUser('restart', UNIT)
    await log(
      'restart cmd',
      stop.ok ? 'ok' : 'fail',
      (stop.stderr || stop.stdout || stop.err || '').slice(0, 200),
    )

    const up = await waitActive(60_000)
    const show = await systemctlUser(
      'show',
      UNIT,
      '-p',
      'ActiveState',
      '-p',
      'SubState',
      '-p',
      'MainPID',
    )
    await log('active=', up, (show.stdout || '').replace(/\n/g, ' '))
    if (!up) {
      await log('ERROR unit not active after restart')
      process.exit(2)
    }
    // 再等 bridge 完成 load env / 首轮 poll
    await new Promise((r) => setTimeout(r, 2500))
  }

  const peer = DEFAULT_PEER
  const cred = await loadCredential()
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const text = [
    '【心跳】bridge 重启完成',
    `time=${stamp}`,
    `unit=${UNIT}`,
    `pid=${(await systemctlUser('show', UNIT, '-p', 'MainPID')).stdout.match(/MainPID=(\d+)/)?.[1] || '?'}`,
    `auto_ingest=${process.env.VAULT_AUTO_INGEST || '0'}`,
    '路由：存库口令才入库；任务+链接进 Grok',
    '状态：通道在线，可继续发任务',
  ].join('\n')

  await log('send heartbeat to', peer.slice(0, 16) + '…')
  try {
    const clientId = await sendWechatText({
      baseUrl: cred.baseUrl,
      token: cred.token,
      to: peer,
      text,
    })
    await log('heartbeat ok', clientId)
    process.exit(0)
  } catch (e) {
    await log('heartbeat FAIL', String(e.message || e).slice(0, 300))
    process.exit(3)
  }
}

main().catch(async (e) => {
  await log('fatal', String(e?.stack || e).slice(0, 500))
  process.exit(1)
})
