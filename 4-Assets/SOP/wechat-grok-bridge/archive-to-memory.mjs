#!/usr/bin/env node
/**
 * 将会话归档目录提炼成可检索记忆，写入 Grok experimental-memory 索引面。
 *
 * 写入位置（供下次会话自动召回）：
 * 1. ~/.grok/sessions-archive/INDEX.md + index.jsonl  — 总索引
 * 2. ~/.grok/memory/MEMORY.md                        — 全局 MEMORY 条目
 * 3. ~/.grok/memory/<workspace-slug>/sessions/*.md   — 项目 session 日志
 * 4. <cwd>/MEMORY.md + FEISHU_TASKLOG.md（若 cwd 可知）— 工作区可见
 *
 * Usage:
 *   node archive-to-memory.mjs --dir /path/to/archived-session-dir \
 *     [--reason hard_max] [--size 44000000] [--chat-key key] [--cwd /path]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function grokHome() {
  return process.env.GROK_HOME || path.join(process.env.HOME || '', '.grok')
}

function arg(name, def = '') {
  const i = process.argv.indexOf(name)
  if (i < 0) return def
  return process.argv[i + 1] || def
}

function hasFlag(name) {
  return process.argv.includes(name)
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch {
    return null
  }
}

function normalizeUserText(raw) {
  let t = String(raw || '')
  // 抽取 <user_query>...</user_query> 正文（Grok chat_history 常见包装）
  const queries = [...t.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)].map(
    (m) => m[1].trim(),
  )
  if (queries.length) t = queries.join(' | ')
  // 去掉其它系统块
  t = t
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, ' ')
    .replace(/<\/?user_query>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t
}

async function extractTopics(chatPath, limit = 8) {
  const topics = []
  const seen = new Set()
  try {
    const text = await fs.readFile(chatPath, 'utf8')
    // 大文件只扫尾部 400KB（最近对话更有召回价值）+ 头部 100KB
    const head = text.slice(0, 100_000)
    const tail = text.length > 500_000 ? text.slice(-400_000) : text
    const chunks = head === tail ? [text] : [head, tail]
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        let o
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (o.type !== 'user' && o.role !== 'user') continue
        let content = o.content
        if (Array.isArray(content)) {
          content = content
            .map((c) => (typeof c === 'string' ? c : c?.text || ''))
            .join('')
        }
        if (typeof content !== 'string') continue
        const t = normalizeUserText(content)
        if (t.length < 8) continue
        // 跳过系统/规则/续写摘要/skill 清单噪声
        if (
          /^你是通过飞书|【铁律】|AGENTS\.md|OS Version:|Prefer using relative/i.test(
            t,
          ) ||
          /This session is being continued|The following skills are available|MCP servers (connected|disconnected|currently connecting)|skills are available for use/i.test(
            t,
          ) ||
          /Summary:|The summary below covers/i.test(t)
        ) {
          continue
        }
        const key = t.slice(0, 80)
        if (seen.has(key)) continue
        seen.add(key)
        topics.push(t.slice(0, 160))
        if (topics.length >= limit) return topics
      }
    }
  } catch {
    /* ignore */
  }
  return topics
}

function workspaceSlug(cwd) {
  if (!cwd) return 'workspace-unknown'
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'ws'
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  // 与 Grok 实际目录命名可能不完全一致；同时写 global + 探测已有 slug
  return `${base}-${hash}`
}

async function findExistingWorkspaceMemoryDir(cwd) {
  const memRoot = path.join(grokHome(), 'memory')
  try {
    const entries = await fs.readdir(memRoot, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'sessions') continue
      // 优先匹配已知 feishu workspace
      if (cwd && e.name.startsWith('workspace-') && cwd.includes('feishu-grok-bridge')) {
        return path.join(memRoot, e.name)
      }
    }
    // feishu bridge workspace 固定 slug 习惯：workspace-c5a0e252
    const preferred = path.join(memRoot, 'workspace-c5a0e252')
    try {
      await fs.access(preferred)
      if (cwd?.includes('feishu-grok-bridge')) return preferred
    } catch {
      /* fallthrough */
    }
  } catch {
    /* ignore */
  }
  return path.join(memRoot, workspaceSlug(cwd || 'unknown'))
}

function formatBytes(n) {
  if (!n || n < 0) return '?'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

async function appendUniqueLine(file, line, uniqueNeedle) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  let cur = ''
  try {
    cur = await fs.readFile(file, 'utf8')
  } catch {
    cur = ''
  }
  if (uniqueNeedle && cur.includes(uniqueNeedle)) return false
  const next = cur.endsWith('\n') || !cur ? cur : `${cur}\n`
  await fs.writeFile(file, `${next}${line}\n`, 'utf8')
  return true
}

async function ensureSection(file, heading, bodyLine) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  let cur = ''
  try {
    cur = await fs.readFile(file, 'utf8')
  } catch {
    cur = `# MEMORY.md\n\n`
  }
  if (bodyLine && cur.includes(bodyLine.slice(0, 60))) return false
  if (!cur.includes(heading)) {
    cur = `${cur.trimEnd()}\n\n${heading}\n\n`
  }
  // insert after heading block end-ish: append to file under section
  cur = `${cur.trimEnd()}\n${bodyLine}\n`
  await fs.writeFile(file, cur, 'utf8')
  return true
}

async function main() {
  const dir = arg('--dir')
  if (!dir) {
    console.error('usage: archive-to-memory.mjs --dir <archived-session-dir> [--reason r] [--size n] [--chat-key k] [--cwd p]')
    process.exit(2)
  }
  const reason = arg('--reason', 'manual')
  const sizeArg = Number(arg('--size', '0')) || 0
  const chatKey = arg('--chat-key', '')
  let cwd = arg('--cwd', '')

  const abs = path.resolve(dir)
  let st
  try {
    st = await fs.stat(abs)
  } catch (e) {
    console.error('dir missing', abs, e.message)
    process.exit(1)
  }
  if (!st.isDirectory()) {
    console.error('not a directory', abs)
    process.exit(1)
  }

  const basename = path.basename(abs)
  // 6479ee4a-....20260719-094504 or plain uuid
  const sessionId = basename.replace(/\.\d{8}-\d{6}$/, '').replace(/\.age\.\d{8}-\d{6}$/, '')
  const summary = (await readJson(path.join(abs, 'summary.json'))) || {}
  const info = summary.info || {}
  cwd = cwd || info.cwd || ''
  const title =
    summary.generated_title ||
    summary.session_summary ||
    summary.title ||
    sessionId.slice(0, 8)
  const numMsgs = summary.num_chat_messages || summary.num_messages || '?'
  const model = summary.current_model_id || summary.primaryModelId || '?'
  const updatedAt = summary.updated_at || summary.last_active_at || ''
  const createdAt = summary.created_at || ''

  let size = sizeArg
  if (!size) {
    // rough du
    size = await (async () => {
      let total = 0
      async function walk(p) {
        const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => [])
        for (const e of entries) {
          const fp = path.join(p, e.name)
          if (e.isDirectory()) await walk(fp)
          else {
            try {
              total += (await fs.stat(fp)).size
            } catch {
              /* */
            }
          }
        }
      }
      await walk(abs)
      return total
    })()
  }

  const topics = await extractTopics(path.join(abs, 'chat_history.jsonl'), 8)
  const ts = new Date().toISOString()
  const date = today()

  const card = [
    `# Archived Session · ${title}`,
    '',
    `- **session_id**: \`${sessionId}\``,
    `- **archive_path**: \`${abs}\``,
    `- **reason**: ${reason}`,
    `- **size**: ${formatBytes(size)} (${size})`,
    `- **cwd**: \`${cwd || '?'}\``,
    chatKey ? `- **chat_key**: \`${chatKey}\`` : null,
    `- **model**: ${model}`,
    `- **messages**: ${numMsgs}`,
    `- **created**: ${createdAt}`,
    `- **updated**: ${updatedAt}`,
    `- **archived_at**: ${ts}`,
    `- **tags**: #session-archive #飞书 #通道 #记忆`,
    '',
    '## Topics (user prompts sample)',
    ...(topics.length ? topics.map((t, i) => `${i + 1}. ${t}`) : ['- (no user topics extracted)']),
    '',
    '## Recall hints',
    `- 下次若提到「旧会话 / 归档 / ${sessionId.slice(0, 8)} / ${title}」：到 \`${abs}\` 或本文件召回。`,
    `- 原始 transcript：\`chat_history.jsonl\`；事件：\`events.jsonl\`。`,
    '',
  ]
    .filter((x) => x !== null)
    .join('\n')

  // 1) archive INDEX.md + index.jsonl
  const archRoot = path.join(grokHome(), 'sessions-archive')
  await fs.mkdir(archRoot, { recursive: true })
  const indexLine = `- **${date}** \`${sessionId.slice(0, 8)}\` · ${title} · ${formatBytes(size)} · reason=${reason} · path=\`${basename}\``
  await appendUniqueLine(path.join(archRoot, 'INDEX.md'), indexLine, sessionId.slice(0, 8) + '`' )
  // ensure header
  try {
    const idx = await fs.readFile(path.join(archRoot, 'INDEX.md'), 'utf8')
    if (!idx.startsWith('#')) {
      await fs.writeFile(
        path.join(archRoot, 'INDEX.md'),
        `# Grok Session Archive Index\n\n> 自动生成；供飞书通道 / experimental-memory 召回。\n\n${idx}`,
        'utf8',
      )
    }
  } catch {
    /* */
  }

  const jsonl = {
    ts,
    session_id: sessionId,
    title,
    reason,
    size,
    cwd,
    chat_key: chatKey || null,
    archive_path: abs,
    topics,
    model,
    num_messages: numMsgs,
    tags: ['session-archive', 'feishu', 'dev198'],
  }
  await fs.appendFile(
    path.join(archRoot, 'index.jsonl'),
    `${JSON.stringify(jsonl)}\n`,
    'utf8',
  )

  // 2) full card next to archive
  const cardPath = path.join(abs, 'MEMORY-CARD.md')
  await fs.writeFile(cardPath, card, 'utf8')

  // 3) global MEMORY.md
  const globalMem = path.join(grokHome(), 'memory', 'MEMORY.md')
  const memLine = `- ★★  会话归档 \`${sessionId.slice(0, 8)}\`「${title}」reason=${reason} size=${formatBytes(size)} path=\`${abs}\` topics=${topics.slice(0, 3).join(' / ') || '—'} [${date}] #session-archive #飞书 #记忆 #路径`
  await ensureSection(globalMem, '## Archived Sessions (auto)', memLine)

  // 4) workspace memory sessions log
  const wsMemDir = await findExistingWorkspaceMemoryDir(cwd)
  const sessDir = path.join(wsMemDir, 'sessions')
  await fs.mkdir(sessDir, { recursive: true })
  const sessFile = path.join(sessDir, `${date}-archive-${sessionId.slice(0, 8)}.md`)
  await fs.writeFile(sessFile, card, 'utf8')
  // workspace MEMORY.md short pointer
  await ensureSection(
    path.join(wsMemDir, 'MEMORY.md'),
    '## Archived Sessions',
    memLine,
  )

  // 5) project cwd MEMORY + tasklog
  if (cwd) {
    try {
      await fs.access(cwd)
      await ensureSection(path.join(cwd, 'MEMORY.md'), '## Archived Sessions (auto)', memLine)
      await appendUniqueLine(
        path.join(cwd, 'FEISHU_TASKLOG.md'),
        `- ${date} session-archive ${sessionId.slice(0, 8)} 「${title}」${formatBytes(size)} → ${basename}`,
        sessionId.slice(0, 8),
      )
    } catch {
      /* cwd may be gone */
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      session_id: sessionId,
      title,
      size,
      card: cardPath,
      sess_file: sessFile,
      topics: topics.length,
    }),
  )
}

main().catch((e) => {
  console.error('[archive-to-memory]', e)
  process.exit(1)
})
