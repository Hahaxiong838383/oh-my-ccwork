#!/usr/bin/env node
/**
 * WeChat iLink context_token 保活（协议层无法自铸 token，只能：
 * 1) 监控年龄；2) 临近过期时软提醒用户回 ping；3) 探活发送是否仍可用）
 *
 * Usage:
 *   node scripts/wechat-context-keepalive.mjs
 *   node scripts/wechat-context-keepalive.mjs --status
 *   node scripts/wechat-context-keepalive.mjs --dry-run
 *   node scripts/wechat-context-keepalive.mjs --pre-morning
 *   node scripts/wechat-context-keepalive.mjs --force-nudge
 *
 * Env:
 *   WX_KEEPALIVE_NUDGE_AGE_H=16      # 超过则考虑软提醒（默认 16h）
 *   WX_KEEPALIVE_STALE_AGE_H=22      # 超过则视为高风险
 *   WX_KEEPALIVE_COOLDOWN_H=10       # 两次提醒最小间隔
 *   WX_KEEPALIVE_PREMORNING_AGE_H=12 # 早间预检阈值阈值
 *   WX_KEEPALIVE_QUIET=1             # 只写状态不发微信（运维）
 */
import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv, createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const STATE_PATH = path.join(ROOT, 'data', 'context-keepalive-state.json')
const TOKEN_PATH = path.join(ROOT, 'data', 'context-tokens.json')

const args = process.argv.slice(2)
const statusOnly = args.includes('--status')
const dryRun = args.includes('--dry-run')
const preMorning = args.includes('--pre-morning')
const forceNudge = args.includes('--force-nudge')
const quiet = args.includes('--quiet') || /^(1|true|yes)$/i.test(process.env.WX_KEEPALIVE_QUIET || '')

function numEnv(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : def
}

const NUDGE_AGE_H = numEnv('WX_KEEPALIVE_NUDGE_AGE_H', 16)
const STALE_AGE_H = numEnv('WX_KEEPALIVE_STALE_AGE_H', 22)
const COOLDOWN_H = numEnv('WX_KEEPALIVE_COOLDOWN_H', 10)
const PRE_AGE_H = numEnv('WX_KEEPALIVE_PREMORNING_AGE_H', 12)

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
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

function loadCredential() {
  loadDotEnv(path.join(ROOT, '.env'))
  const secret = process.env.WECHAT_CREDENTIAL_SECRET
  const filePath = process.env.WECHAT_ACCOUNTS_FILE
  if (!secret || secret.length < 32) throw new Error('WECHAT_CREDENTIAL_SECRET missing')
  if (!filePath) throw new Error('WECHAT_ACCOUNTS_FILE missing')
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const accounts = Object.values(raw.accounts || {})
  if (!accounts.length) throw new Error('no wechat accounts')
  accounts.sort((a, b) =>
    String(b.savedAt || '').localeCompare(String(a.savedAt || '')),
  )
  const acc = accounts[0]
  const token =
    typeof acc.token === 'string' ? acc.token : decryptSecret(secret, acc.token)
  return {
    token,
    baseUrl: acc.baseUrl || 'https://ilinkai.weixin.qq.com',
    accountId: acc.accountId || '',
    userId: acc.userId || '',
  }
}

function resolvePeers(cred) {
  const set = new Set()
  for (const src of [
    process.env.DREAM_NOTIFY_USER_IDS || '',
    process.env.ALLOW_USER_IDS || '',
    process.env.ALLOW_OPEN_IDS || '',
    process.env.HEARTBEAT_PEER || '',
  ]) {
    for (const p of src.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      if (p.length >= 16) set.add(p)
    }
  }
  if (cred?.userId && String(cred.userId).length >= 16) {
    set.add(String(cred.userId))
  }
  // also peers present in token map
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const map = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
      for (const key of Object.keys(map || {})) {
        const idx = key.indexOf(':')
        if (idx > 0) {
          const peer = key.slice(idx + 1)
          if (peer.length >= 16) set.add(peer)
        }
      }
    }
  } catch {
    /* ignore */
  }
  return [...set]
}

function loadTokenMeta(accountId, peerId) {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null
    const map = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
    const row = map[`${accountId}:${peerId}`]
    const tok = row?.token
    if (typeof tok !== 'string' || !tok.trim()) return null
    const updatedAt = row?.updatedAt || null
    let ageSec = null
    if (updatedAt) {
      const t = Date.parse(updatedAt)
      if (Number.isFinite(t)) ageSec = Math.max(0, Math.round((Date.now() - t) / 1000))
    }
    return { token: tok.trim(), updatedAt, ageSec }
  } catch {
    return null
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return {}
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveState(st) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
}

function ageHours(ageSec) {
  if (ageSec == null) return null
  return Math.round((ageSec / 3600) * 10) / 10
}

function cooldownOk(state, peerId, cooldownH) {
  const row = state.peers?.[peerId]
  if (!row?.lastNudgeAt) return true
  const t = Date.parse(row.lastNudgeAt)
  if (!Number.isFinite(t)) return true
  return Date.now() - t >= cooldownH * 3600 * 1000
}

function nudgeText(preMorning) {
  if (preMorning) {
    return [
      '【通道保活·早间】',
      '会话将过期，回 ping 或 保活 续期，',
      '否则 07:30 梦志/主动推送可能失败。',
    ].join('')
  }
  return [
    '【通道保活】',
    '已超半天无入站，context_token 将失效。',
    '回 ping 或 保活 续期即可（一秒）。',
  ].join('')
}

async function sendWithChain(cred, to, text, contextToken) {
  // Prefer second-brain wechat-send (cached→empty→no_ctx chain)
  const home = process.env.HOME || ''
  const sendLib = path.join(
    home,
    'second-brain/90-System/scripts/lib/wechat-send.mjs',
  )
  if (fs.existsSync(sendLib)) {
    const mod = await import(pathToFileURL(sendLib).href)
    return mod.sendWechatText({
      baseUrl: cred.baseUrl,
      token: cred.token,
      to,
      text,
      contextToken,
      accountId: cred.accountId,
      tries: 4,
    })
  }
  // fallback: direct api + cached only
  const api = await import(pathToFileURL(path.join(ROOT, 'wechat-api.mjs')).href)
  const id = await api.sendWechatText({
    baseUrl: cred.baseUrl,
    token: cred.token,
    to,
    text,
    contextToken,
  })
  return { ok: true, client_id: id, context_strategy: 'direct' }
}

async function main() {
  const cred = loadCredential()
  const peers = resolvePeers(cred)
  const state = loadState()
  state.peers = state.peers || {}

  const thresholdH = preMorning ? PRE_AGE_H : NUDGE_AGE_H
  const report = {
    ok: true,
    at: new Date().toISOString(),
    mode: statusOnly
      ? 'status'
      : preMorning
        ? 'pre-morning'
        : forceNudge
          ? 'force-nudge'
          : 'keepalive',
    dryRun,
    threshold_h: thresholdH,
    peers: [],
  }

  if (!peers.length) {
    report.ok = false
    report.err = 'no notify peers'
    console.log(JSON.stringify(report, null, 2))
    process.exit(2)
  }

  for (const peer of peers) {
    const meta = loadTokenMeta(cred.accountId, peer)
    const ageH = ageHours(meta?.ageSec)
    const row = {
      peer: peer.slice(0, 12) + '…',
      peer_len: peer.length,
      updatedAt: meta?.updatedAt || null,
      age_h: ageH,
      has_token: !!meta?.token,
      action: 'none',
      send: null,
    }

    if (!meta?.token) {
      row.action = 'missing_token'
      row.risk = 'high'
      report.peers.push(row)
      continue
    }

    if (ageH != null && ageH >= STALE_AGE_H) row.risk = 'high'
    else if (ageH != null && ageH >= thresholdH) row.risk = 'medium'
    else row.risk = 'low'

    const needNudge =
      forceNudge ||
      (ageH != null && ageH >= thresholdH && cooldownOk(state, peer, COOLDOWN_H))

    if (statusOnly || quiet) {
      row.action = needNudge ? 'would_nudge' : 'ok'
      report.peers.push(row)
      continue
    }

    if (!needNudge) {
      row.action = 'ok_fresh'
      report.peers.push(row)
      continue
    }

    const text = nudgeText(preMorning)
    row.action = dryRun ? 'dry_nudge' : 'nudge'
    if (dryRun) {
      row.nudge_preview = text
      report.peers.push(row)
      continue
    }

    try {
      const res = await sendWithChain(cred, peer, text, meta.token)
      row.send = {
        ok: true,
        strategy: res.context_strategy || null,
        token_age_sec: res.token_age_sec ?? meta.ageSec,
      }
      state.peers[peer] = {
        ...(state.peers[peer] || {}),
        lastNudgeAt: new Date().toISOString(),
        lastNudgeOk: true,
        lastAgeH: ageH,
      }
      state.lastOkAt = new Date().toISOString()
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 240)
      row.send = { ok: false, err: msg }
      row.risk = 'high'
      report.ok = false
      state.peers[peer] = {
        ...(state.peers[peer] || {}),
        lastNudgeAt: new Date().toISOString(),
        lastNudgeOk: false,
        lastErr: msg,
        lastAgeH: ageH,
      }
      state.lastFailAt = new Date().toISOString()
    }
    report.peers.push(row)
  }

  state.lastRun = report
  saveState(state)
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}

main().catch((e) => {
  console.log(
    JSON.stringify({
      ok: false,
      err: String(e?.message || e).slice(0, 300),
    }),
  )
  process.exit(1)
})
