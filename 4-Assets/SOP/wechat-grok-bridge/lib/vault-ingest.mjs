/**
 * Ingest WeChat content into the Obsidian second-brain vault.
 *
 * 入库触发（默认严格，避免「带链接的任务」被误吞）：
 * 1. 显式前缀：存库 / 入库 / 收藏 / 记录 / /kb / /save …
 * 2. 正文含入库类关键词，且不像执行任务句
 * 3. 可选：VAULT_AUTO_INGEST=1 时，仅「薄分享」（几乎只有链接/附件、无任务语气）才自动入库
 *
 * 注意：公众号链接不再无条件强制入库；带指令的链接消息应走 Grok 执行。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** 句首显式入库前缀（命中后整句走入库快路径，不再 spawn Grok） */
const SAVE_PREFIX_RE =
  /^(?:存库|入库|收藏|记录|记一下|记入|存下|存进|帮我存|保存一下|保存到知识库|记入知识库|加入知识库|放进知识库|\/kb|\/save|kb:|save:)\s*/i

/**
 * 正文中的入库意图（非句首也可）。
 * 需配合「非任务句」判断，避免「存一下思路再执行…」误触发。
 */
const SAVE_KEYWORD_RE =
  /(?:存库|入库|收藏到知识库|记入知识库|存进知识库|加入知识库|保存到知识库|记录到知识库|放到知识库|放进知识库|帮我存(?:一下|库)?|存到(?:库|知识库)|记到知识库)/i

/**
 * 执行/分析类任务语气：有则优先进 Grok，禁止因链接/附件自动入库。
 * （显式「存库」前缀仍优先进库）
 */
const TASK_INTENT_RE =
  /(?:仔细|读取并|理解这|举一反三|总结出|世界观|方法论|执行|排查|调试|优化|修复|实现|重构|部署|安装|落地|开干|开工|接着干|自检|验收|推进任务|帮我分析|帮我改|帮我修|帮我写|请你|你再|查查相关|提高你的|任务执行|改一下|修一下|写一个|跑一下|看一下怎么|为什么|怎么实现|如何实现)/i

/** 微信公众号文章链接 */
export const WECHAT_ARTICLE_RE =
  /https?:\/\/(?:mp\.weixin\.qq\.com\/s[\/?#]|mp\.weixin\.qq\.com\/s\?|weixin\.qq\.com\/s[\/?#])/i

/** 薄分享残留里允许的短口头语（去掉后仍算「几乎只有链接」） */
const THIN_SHARE_PREFIX_RE =
  /^(?:看看这篇|看看这个|转发|分享|链接|文章|这个|这篇)[:：\s]*/i

export function defaultVaultPath() {
  return (
    process.env.SECOND_BRAIN_VAULT ||
    path.join(process.env.HOME || '', 'second-brain')
  )
}

function envOn(name, env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env[name] || ''))
}

/**
 * 是否像「要 Agent 执行/分析」而不是「单纯存档」。
 */
export function looksLikeTaskIntent(text) {
  const t = String(text || '').trim()
  if (!t) return false
  // 去掉 URL 后仍很长，多半是任务说明
  const sansUrl = t
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (TASK_INTENT_RE.test(t) || TASK_INTENT_RE.test(sansUrl)) return true
  // 无入库关键词、且去链后仍有较长中文指令
  if (
    !SAVE_PREFIX_RE.test(t) &&
    !SAVE_KEYWORD_RE.test(t) &&
    sansUrl.length >= 28 &&
    /[\u4e00-\u9fff]{8,}/.test(sansUrl)
  ) {
    return true
  }
  return false
}

/**
 * 几乎只有链接/附件 + 极短口头语 → 可视为「转发存档」候选。
 */
export function isThinShare(text, mediaCount = 0) {
  const raw = String(text || '').trim()
  const sansUrl = raw
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, ' ')
    .replace(THIN_SHARE_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  const hasUrl = /https?:\/\//i.test(raw)
  if (mediaCount > 0 && sansUrl.length <= 12) return true
  if (hasUrl && sansUrl.length <= 12) return true
  return false
}

/**
 * @returns {{ isSave: boolean, body: string, reason: string }}
 */
export function parseSaveIntent(text) {
  const raw = String(text || '').trim()
  if (!raw) return { isSave: false, body: '', reason: 'empty' }

  // 1) 句首显式前缀：最高优先，整句入库（即使后半有任务词）
  if (SAVE_PREFIX_RE.test(raw)) {
    return {
      isSave: true,
      body: raw.replace(SAVE_PREFIX_RE, '').trim(),
      reason: 'prefix',
    }
  }

  // 2) 正文含入库关键词，但像任务句 → 不抢 Grok（避免误吞）
  if (SAVE_KEYWORD_RE.test(raw)) {
    if (looksLikeTaskIntent(raw)) {
      return { isSave: false, body: raw, reason: 'keyword_but_task' }
    }
    return { isSave: true, body: raw, reason: 'keyword' }
  }

  return { isSave: false, body: raw, reason: 'none' }
}

export function extractUrls(text) {
  const s = String(text || '')
  const re = /https?:\/\/[^\s<>"')\]]+/gi
  const urls = s.match(re) || []
  return [...new Set(urls.map((u) => u.replace(/[.,;:!?。，；：！？]+$/, '')))]
}

export function isWechatArticleUrl(url) {
  return WECHAT_ARTICLE_RE.test(String(url || ''))
}

export function extractWechatArticleUrls(text) {
  return extractUrls(text).filter(isWechatArticleUrl)
}

function slugify(s, max = 60) {
  let t = String(s || '')
    .replace(/https?:\/\/\S+/gi, '')
    // ISO 时间戳会污染文件名（冒号变空格）
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/gi, '')
    .replace(/[\\/:*?"<>|#^[\]{}]/g, ' ')
    .replace(/[T ]?\d{2}\s+\d{2}\s+\d{2}(?:\.\d+)?Z?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) t = 'note'
  if (t.length > max) t = t.slice(0, max).trim()
  return t || 'note'
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function yamlEscape(v) {
  const s = String(v ?? '')
  if (/[:#\[\]{},&*?|>!%@`'"\\\n]/.test(s) || s === '') {
    return JSON.stringify(s)
  }
  return s
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`,
    'i',
  )
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`,
    'i',
  )
  const m = html.match(re) || html.match(re2)
  return m ? decodeHtmlEntities(m[1]).trim() : ''
}

function stripTags(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  )
}

/**
 * Best-effort fetch of a WeChat public account article page.
 * @returns {Promise<{url,title,account,author,description,markdown,parseStatus,error?}>}
 */
export async function fetchWechatArticle(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://mp.weixin.qq.com/',
      },
      redirect: 'follow',
    })
    const html = await res.text()
    if (!res.ok) {
      return {
        url,
        title: '',
        account: '',
        author: '',
        description: '',
        markdown: '',
        parseStatus: 'http_error',
        error: `HTTP ${res.status}`,
      }
    }
    const title =
      metaContent(html, 'og:title') ||
      (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
        ? decodeHtmlEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)[1])
            .replace(/\s*[-_|].*$/, '')
            .trim()
        : '') ||
      '微信公众号文章'
    const description =
      metaContent(html, 'og:description') ||
      metaContent(html, 'description')
    const account =
      metaContent(html, 'og:article:author') ||
      (html.match(/var\s+nickname\s*=\s*htmlDecode\(["']([^"']+)["']\)/)?.[1]
        ? decodeHtmlEntities(
            html.match(/var\s+nickname\s*=\s*htmlDecode\(["']([^"']+)["']\)/)[1],
          )
        : '') ||
      (html.match(/id="js_name"[^>]*>([^<]+)</)?.[1] || '').trim()
    const author =
      (html.match(/var\s+author\s*=\s*["']([^"']*)["']/)?.[1] || '').trim()

    let contentHtml = ''
    const mContent =
      html.match(
        /id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<script/i,
      ) ||
      html.match(/id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i)
    if (mContent) contentHtml = mContent[1]

    let markdown = ''
    if (contentHtml && contentHtml.length > 80) {
      markdown = stripTags(contentHtml)
    } else if (description) {
      markdown = description
    }

    // anti-bot / login wall often returns short body
    const parseStatus =
      markdown.length > 120
        ? 'ok'
        : description
          ? 'partial'
          : 'thin'

    if (!markdown) {
      markdown = `（未能完整抓取正文，请点开原文）\n\n${url}`
    }

    return {
      url,
      title: title || '微信公众号文章',
      account: account || '',
      author: author || '',
      description,
      markdown,
      parseStatus,
    }
  } catch (e) {
    return {
      url,
      title: '微信公众号文章',
      account: '',
      author: '',
      description: '',
      markdown: `（抓取失败：${String(e.message || e).slice(0, 120)}）\n\n${url}`,
      parseStatus: 'error',
      error: String(e.message || e).slice(0, 200),
    }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Write a WeChat article note under 00-Inbox/wechat/
 */
export async function writeWechatArticleNote(
  article,
  { vaultPath, peerId = '', messageId = '' } = {},
) {
  const vaultRoot = path.resolve(vaultPath || defaultVaultPath())
  const inboxDir = path.join(vaultRoot, '00-Inbox', 'wechat')
  await fs.mkdir(inboxDir, { recursive: true })

  const d = new Date()
  const day =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  const title = article.title || '微信公众号文章'
  const baseName = slugify(`${day} - ${title}`, 100)
  const hash = createHash('sha1')
    .update(`${article.url}|${messageId}|${peerId}`)
    .digest('hex')
    .slice(0, 8)

  // de-dupe by source_url in wechat inbox
  try {
    const names = await fs.readdir(inboxDir)
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const p = path.join(inboxDir, name)
      const text = await fs.readFile(p, 'utf8')
      if (text.includes(article.url)) {
        const relPath = path.relative(vaultRoot, p).split(path.sep).join('/')
        return {
          notePath: p,
          relPath,
          title,
          urls: [article.url],
          mediaCount: 0,
          deduped: true,
          parseStatus: article.parseStatus,
        }
      }
    }
  } catch {
    /* empty */
  }

  let fileName = `${baseName}.md`
  let notePath = path.join(inboxDir, fileName)
  let i = 1
  while (true) {
    try {
      await fs.access(notePath)
      fileName = `${baseName} (${i}).md`
      notePath = path.join(inboxDir, fileName)
      i += 1
    } catch {
      break
    }
  }

  const nowIso = d.toISOString()
  const content = [
    '---',
    'source: wechat-chat-link',
    'tags: [inbox, wechat, chat-link]',
    `source_url: ${JSON.stringify(article.url)}`,
    `title: ${JSON.stringify(title)}`,
    `account: ${JSON.stringify(article.account || '')}`,
    `author: ${JSON.stringify(article.author || '')}`,
    `saved_at: ${JSON.stringify(nowIso)}`,
    `parse_status: ${JSON.stringify(article.parseStatus || '')}`,
    `peer: ${yamlEscape(peerId ? peerId.slice(0, 16) : '')}`,
    `message_id: ${yamlEscape(String(messageId || ''))}`,
    `link_hash: ${yamlEscape(hash)}`,
    '---',
    '',
    `# ${title}`,
    '',
    article.account ? `> 公众号：${article.account}` : '',
    article.account ? '' : '',
    String(article.markdown || '').trim(),
    '',
    '## 原文链接',
    '',
    article.url,
    '',
    '## 处理状态',
    '',
    '- [ ] 已读',
    '- [ ] 已提炼为文献笔记',
    '- [ ] 已挂到主题页',
    '',
  ]
    .filter((line, idx, arr) => {
      // drop double blanks from empty account lines carefully
      if (line === '' && arr[idx - 1] === '') return false
      return true
    })
    .join('\n')

  await fs.writeFile(notePath, content, 'utf8')
  const relPath = path.relative(vaultRoot, notePath).split(path.sep).join('/')
  return {
    notePath,
    relPath,
    title,
    urls: [article.url],
    mediaCount: 0,
    parseStatus: article.parseStatus,
  }
}

/**
 * Copy media files into vault attachments, return relative vault paths.
 */
async function copyMedia(files, vaultRoot, dayDir) {
  const out = []
  const attRoot = path.join(vaultRoot, 'attachments', 'bridge', dayDir)
  await fs.mkdir(attRoot, { recursive: true })
  for (const f of files || []) {
    const src = f.path || f.absPath
    if (!src) continue
    try {
      const base = path.basename(src)
      const dest = path.join(attRoot, base)
      await fs.copyFile(src, dest)
      const rel = path
        .relative(vaultRoot, dest)
        .split(path.sep)
        .join('/')
      out.push({
        rel,
        name: base,
        kind: f.kind || f.type || 'file',
        mime: f.mime || '',
      })
    } catch (e) {
      out.push({ error: String(e.message || e).slice(0, 120), src })
    }
  }
  return out
}

/**
 * Write an inbox note under 00-Inbox/bridge/
 * @returns {{ notePath: string, relPath: string, title: string }}
 */
export async function ingestToVault({
  text = '',
  mediaFiles = [],
  peerId = '',
  chatKind = 'dm',
  messageId = '',
  vaultPath,
  source = 'wechat-bridge',
  preferWechatFetch = true,
} = {}) {
  const vaultRoot = path.resolve(vaultPath || defaultVaultPath())
  const body = String(text || '').trim()
  const urls = extractUrls(body)
  const wechatUrls = urls.filter(isWechatArticleUrl)

  // 纯公众号文章链接：走 wechat 目录 + 抓取正文
  if (
    preferWechatFetch &&
    wechatUrls.length > 0 &&
    mediaFiles.length === 0
  ) {
    const notes = []
    for (const u of wechatUrls) {
      const art = await fetchWechatArticle(u)
      const note = await writeWechatArticleNote(art, {
        vaultPath: vaultRoot,
        peerId,
        messageId,
      })
      notes.push(note)
    }
    // 若还有非微信 URL 或足够长的额外正文，再写 bridge 摘要
    // （「看看这篇 / 转发」等短前缀不单独落盘）
    const otherUrls = urls.filter((u) => !isWechatArticleUrl(u))
    const bodySansWechat = body
      .replace(/https?:\/\/[^\s<>"')\]]+/gi, '')
      .replace(
        /^(?:看看这篇|看看这个|转发|分享|收藏|存下|存库|链接|文章)[:：\s]*/i,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim()
    const residualMeaningful =
      bodySansWechat.length >= 24 ||
      (bodySansWechat.length >= 8 && /[a-zA-Z]{4,}/.test(bodySansWechat))
    if (otherUrls.length || residualMeaningful) {
      const extra = await ingestPlain({
        text: [bodySansWechat, ...otherUrls].filter(Boolean).join('\n'),
        mediaFiles: [],
        peerId,
        chatKind,
        messageId: `${messageId}-extra`,
        vaultRoot,
        source,
      })
      notes.push(extra)
    }
    const primary = notes[0]
    return {
      notePath: primary.notePath,
      relPath: primary.relPath,
      title: primary.title,
      urls,
      mediaCount: 0,
      notes: notes.map((n) => ({
        path: n.relPath,
        title: n.title,
        parseStatus: n.parseStatus,
      })),
      kind: 'wechat',
    }
  }

  return ingestPlain({
    text: body,
    mediaFiles,
    peerId,
    chatKind,
    messageId,
    vaultRoot,
    source,
  })
}

async function ingestPlain({
  text,
  mediaFiles,
  peerId,
  chatKind,
  messageId,
  vaultRoot,
  source,
}) {
  const body = String(text || '').trim()
  const urls = extractUrls(body)
  const d = new Date()
  const day =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  const dayCompact = day.replace(/-/g, '')

  const inboxDir = path.join(vaultRoot, '00-Inbox', 'bridge')
  await fs.mkdir(inboxDir, { recursive: true })

  const media = await copyMedia(mediaFiles, vaultRoot, dayCompact)
  const titleBase =
    slugify(body.split('\n')[0] || urls[0] || media[0]?.name || 'capture') ||
    'capture'
  const hash = createHash('sha1')
    .update(`${messageId}|${peerId}|${body}|${Date.now()}`)
    .digest('hex')
    .slice(0, 6)
  const fileName = `${stamp()}-${titleBase}-${hash}.md`
  const notePath = path.join(inboxDir, fileName)
  const relPath = path.relative(vaultRoot, notePath).split(path.sep).join('/')

  const nowIso = d.toISOString()
  const lines = [
    '---',
    `title: ${yamlEscape(titleBase)}`,
    `type: inbox`,
    `status: raw`,
    `source: ${yamlEscape(source)}`,
    `created: ${yamlEscape(nowIso)}`,
    `peer: ${yamlEscape(peerId ? peerId.slice(0, 16) : '')}`,
    `chat: ${yamlEscape(chatKind)}`,
    `message_id: ${yamlEscape(String(messageId || ''))}`,
    `urls: ${JSON.stringify(urls)}`,
    `tags: [inbox, bridge, wechat]`,
    '---',
    '',
    `# ${titleBase}`,
    '',
    '## 原文',
    '',
    body || '（无文本，见附件）',
    '',
  ]

  if (urls.length) {
    lines.push('## 链接', '')
    for (const u of urls) lines.push(`- ${u}`)
    lines.push('')
  }

  if (media.length) {
    lines.push('## 附件', '')
    for (const m of media) {
      if (m.error) {
        lines.push(`- 复制失败: ${m.error}`)
        continue
      }
      if (m.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(m.name)) {
        lines.push(`![[${m.rel}]]`)
      } else {
        lines.push(`- [[${m.rel}|${m.name}]]`)
      }
    }
    lines.push('')
  }

  lines.push(
    '## 处理状态',
    '',
    '- [ ] 已读',
    '- [ ] 已提炼为文献笔记',
    '- [ ] 已挂到主题页',
    '',
  )

  await fs.writeFile(notePath, lines.join('\n'), 'utf8')
  return {
    notePath,
    relPath,
    title: titleBase,
    urls,
    mediaCount: media.length,
    kind: 'bridge',
  }
}

/**
 * 无显式入库口令时，是否仍自动入库。
 *
 * 默认 false（推荐）。仅当 VAULT_AUTO_INGEST=1 且消息是「薄分享」
 * （几乎只有链接/附件、无任务语气）时为 true。
 *
 * 公众号链接不再无条件强制入库。
 * 可选 VAULT_AUTO_INGEST_WECHAT=1：薄分享里的公众号链单独放行（仍可关总开关时单独开）。
 */
export function shouldAutoIngest(text, mediaCount, env = process.env) {
  const t = String(text || '').trim()
  // 已由 parseSaveIntent 处理的显式意图，这里只回答「自动」
  if (parseSaveIntent(t).isSave) return false

  // 任务语气：绝不因链接/附件自动入库
  if (looksLikeTaskIntent(t)) return false

  const thin = isThinShare(t, mediaCount)
  if (!thin) return false

  const autoAll = envOn('VAULT_AUTO_INGEST', env)
  const autoWechat = envOn('VAULT_AUTO_INGEST_WECHAT', env)
  const hasWechat = extractWechatArticleUrls(t).length > 0
  const hasUrl = extractUrls(t).length > 0

  if (autoAll && (mediaCount > 0 || hasUrl)) return true
  // 仅薄分享公众号：需显式 WECHAT 开关（且未开总自动时仍可单独开）
  if (autoWechat && hasWechat) return true
  return false
}
