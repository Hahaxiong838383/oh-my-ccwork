/**
 * Fast-path WeChat commands for second-brain (no Grok spawn).
 * 知识库状态 / 整理知识库 / 本周复盘 / 问知识库
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function vaultRoot() {
  return (
    process.env.SECOND_BRAIN_VAULT ||
    path.join(process.env.HOME || '', 'second-brain')
  )
}

export function scriptsDir() {
  return path.join(vaultRoot(), '90-System', 'scripts')
}

/**
 * @returns {{ kind: string, arg?: string } | null}
 */
export function matchKbCommand(text) {
  const t = String(text || '')
    .trim()
    .replace(/^\/+/, '')
  if (!t) return null
  const n = t.replace(/[。！？!?.]+$/, '').trim()

  // 问知识库 / kb ask / 知识库问
  const ask =
    n.match(/^(?:问知识库|知识库问|kb\s*ask|kb\s*问)[:：\s]+(.+)$/i) ||
    n.match(/^(?:问知识库|知识库问)\s*$/i)
  if (ask) {
    return { kind: 'ask', arg: (ask[1] || '').trim() }
  }

  if (/^(知识库状态|kb状态|kb status|vault status)$/i.test(n)) {
    return { kind: 'status' }
  }
  if (/^(整理知识库|处理inbox|process inbox|kb process|总结知识库)$/i.test(n)) {
    return { kind: 'process' }
  }
  if (
    /^(夜间做梦|知识库做梦|dream|kb dream|开始做梦)$/i.test(n)
  ) {
    return { kind: 'dream' }
  }
  if (
    /^(早间梦志|推送梦志|梦志推送|morning dream|kb morning)$/i.test(n)
  ) {
    return { kind: 'morning' }
  }
  if (
    /^(同步记忆|记忆同步|memory sync|kb memory)$/i.test(n)
  ) {
    return { kind: 'memory' }
  }
  if (/^(本周复盘|周报复盘|weekly review|kb weekly)$/i.test(n)) {
    return { kind: 'weekly' }
  }
  if (
    /^(知识库体检|库体检|kb\s*lint|lint\s*kb|健康检查)$/i.test(n)
  ) {
    return { kind: 'lint' }
  }
  if (/^(刷新索引|更新索引|wiki\s*index|kb\s*index)$/i.test(n)) {
    return { kind: 'index' }
  }
  if (/^(更新概览|库概览|wiki\s*overview|kb\s*overview)$/i.test(n)) {
    return { kind: 'overview' }
  }
  if (
    /^(求职状态|求职看板|career\s*status|job\s*status)$/i.test(n)
  ) {
    return { kind: 'career_status' }
  }
  return null
}

function runCmd(bin, args, { timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { ...env, SECOND_BRAIN_VAULT: vaultRoot() },
      cwd: scriptsDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        text: `超时 ${timeoutMs}ms\n${stdout.slice(-800)}\n${stderr.slice(-400)}`,
      })
    }, timeoutMs)
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
      resolve({ ok: false, text: String(err.message || err) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const out = (stdout || stderr || '').trim()
      if (code === 0) {
        resolve({ ok: true, text: out || '（无输出）' })
      } else {
        resolve({
          ok: false,
          text: `exit ${code}\n${out.slice(0, 1500)}`,
        })
      }
    })
  })
}

/**
 * Run a matched kb command; returns WeChat-ready text.
 * @param {string|{kind:string,arg?:string}} kindOrMatch
 */
export async function runKbCommand(kindOrMatch) {
  const scripts = scriptsDir()
  const match =
    typeof kindOrMatch === 'string'
      ? { kind: kindOrMatch, arg: '' }
      : kindOrMatch || {}
  const kind = match.kind

  if (kind === 'status') {
    const r = await runCmd('bash', [path.join(scripts, 'kb-status.sh')], {
      timeoutMs: 20_000,
    })
    return r.ok ? r.text : `【知识库状态失败】\n${r.text}`
  }

  if (kind === 'process') {
    // 1) 归档骨架（wechat 不改原文）
    const r1 = await runCmd(
      'node',
      [path.join(scripts, 'process-inbox.mjs'), '--dir', 'all', '--limit', '30'],
      { timeoutMs: 90_000 },
    )
    // 2) 火山 LLM 写 Literature 摘要层
    const r2 = await runCmd(
      'node',
      [
        path.join(scripts, 'summarize-kb.mjs'),
        '--dir',
        'all',
        '--limit',
        '8',
      ],
      { timeoutMs: 300_000 },
    )

    const lines = ['【整理知识库】']
    if (r1.ok) {
      try {
        const j = JSON.parse(r1.text)
        lines.push(`归档条数=${j.count ?? 0}（原文不改写）`)
        for (const item of (j.results || []).slice(0, 5)) {
          if (item.error) lines.push(`· 归档错: ${item.error}`)
          else if (!item.skipped)
            lines.push(`· 归档 ${item.from} → ${item.literature || item.source}`)
        }
      } catch {
        lines.push(`归档：${r1.text.slice(0, 400)}`)
      }
    } else {
      lines.push(`归档失败：${r1.text.slice(0, 300)}`)
    }

    if (r2.ok) {
      try {
        const j = JSON.parse(r2.text)
        lines.push(
          `LLM摘要 完成=${j.summarized ?? 0} 跳过=${j.skipped ?? 0} 失败=${j.failed ?? 0}`,
        )
        for (const item of (j.results || []).slice(0, 6)) {
          if (item.ok)
            lines.push(`· 摘要 ${item.title} → ${item.literature}`)
          else if (item.error)
            lines.push(`· 摘要错: ${item.error}`)
          else if (item.skipped && item.reason === 'up-to-date')
            lines.push(`· 已是最新: ${item.source}`)
        }
      } catch {
        lines.push(`摘要：${r2.text.slice(0, 500)}`)
      }
    } else {
      lines.push(`LLM摘要失败：${r2.text.slice(0, 400)}`)
    }
    lines.push('调取：说「问知识库 …」')
    return lines.join('\n')
  }

  if (kind === 'ask') {
    const q = (match.arg || '').trim()
    if (!q) {
      return '【问知识库】请带上问题，例如：问知识库 Grok Voice 支持多少语言？'
    }
    const r = await runCmd(
      'node',
      [path.join(scripts, 'kb-ask.mjs'), '--text', q],
      { timeoutMs: 120_000 },
    )
    if (!r.ok) return `【问知识库失败】\n${r.text.slice(0, 800)}`
    try {
      const j = JSON.parse(r.text)
      const cites = (j.citations || [])
        .slice(0, 5)
        .map((c) => `· ${c.path}`)
        .join('\n')
      return [
        '【问知识库】',
        j.answer || '（无回答）',
        cites ? `引用：\n${cites}` : '',
        j.model ? `model=${j.model}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【问知识库】\n${r.text.slice(0, 1600)}`
    }
  }

  if (kind === 'dream') {
    const r = await runCmd(
      'node',
      [path.join(scripts, 'dream-nightly.mjs'), '--limit', '8'],
      { timeoutMs: 360_000 },
    )
    if (!r.ok) return `【夜间做梦失败】\n${r.text.slice(0, 800)}`
    try {
      const j = JSON.parse(r.text)
      return [
        '【夜间做梦】完成',
        j.one_line ? `一句话：${j.one_line}` : '',
        `梦志：${j.journal || ''}`,
        `候选Permanent：${j.candidates_written ?? 0}`,
        `主题更新：${j.topics_updated ?? 0}`,
        `连接簇：${j.clusters ?? 0} / 链接：${j.links ?? 0}`,
        j.model ? `model=${j.model}` : '',
        '详见 50-Periodic/daily/*-dream.md',
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【夜间做梦】\n${r.text.slice(0, 1600)}`
    }
  }

  if (kind === 'morning') {
    const r = await runCmd(
      'node',
      [path.join(scripts, 'dream-morning-push.mjs')],
      { timeoutMs: 90_000 },
    )
    if (!r.ok) return `【早间梦志失败】\n${r.text.slice(0, 800)}`
    try {
      const j = JSON.parse(r.text)
      return [
        '【早间梦志】已推送',
        `day=${j.day || ''}`,
        `path=${j.path || ''}`,
        `results=${JSON.stringify(j.results || []).slice(0, 200)}`,
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【早间梦志】\n${r.text.slice(0, 1200)}`
    }
  }

  if (kind === 'memory') {
    const r = await runCmd(
      'node',
      [path.join(scripts, 'dream-memory-sync.mjs'), '--both'],
      { timeoutMs: 60_000 },
    )
    if (!r.ok) return `【记忆同步失败】\n${r.text.slice(0, 800)}`
    try {
      const j = JSON.parse(r.text)
      return [
        '【记忆同步】完成',
        j.out?.dream ? `dream→memory: ${j.out.dream}` : '',
        j.out?.card ? `card: ${j.out.card}` : '',
        j.in?.path ? `memory→vault: ${j.in.path} (${j.in.lines} lines)` : '',
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【记忆同步】\n${r.text.slice(0, 1200)}`
    }
  }

  if (kind === 'lint') {
    const r = await runCmd(
      'node',
      [path.join(scripts, 'kb-lint.mjs'), '--json'],
      { timeoutMs: 60_000 },
    )
    if (!r.ok && r.code !== 2) return `【知识库体检失败】\n${r.text.slice(0, 800)}`
    try {
      const j = JSON.parse(r.text)
      const topUnsum = (j.unsummarized_inbox || [])
        .slice(0, 5)
        .map((x) => `· ${x.path}`)
        .join('\n')
      return [
        '【知识库体检】',
        `grade=${j.grade} score=${j.score}`,
        `未摘要=${j.stats?.unsummarized ?? '?'} 孤儿Lit=${j.stats?.orphan_lit ?? '?'} 断链≈${j.stats?.broken ?? '?'} 薄主题=${j.stats?.thin_topics ?? '?'}`,
        `lit=${j.stats?.literature} perm=${j.stats?.permanent} topics=${j.stats?.topics} queries=${j.stats?.queries}`,
        topUnsum ? `待摘要：\n${topUnsum}` : '',
        '说「整理知识库」可补摘要',
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【知识库体检】\n${r.text.slice(0, 1200)}`
    }
  }

  if (kind === 'index') {
    const r = await runCmd('node', [path.join(scripts, 'wiki-index.mjs')], {
      timeoutMs: 30_000,
    })
    if (!r.ok) return `【刷新索引失败】\n${r.text.slice(0, 600)}`
    try {
      const j = JSON.parse(r.text)
      return [
        '【刷新索引】完成',
        `index=${j.index || 'index.md'}`,
        `home=${j.home || 'HOME.md'}`,
        j.updated ? `updated=${j.updated}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【刷新索引】\n${r.text.slice(0, 800)}`
    }
  }

  if (kind === 'overview') {
    const r = await runCmd(
      'node',
      [path.join(scripts, 'wiki-overview.mjs')],
      { timeoutMs: 60_000 },
    )
    if (!r.ok) return `【更新概览失败】\n${r.text.slice(0, 600)}`
    try {
      const j = JSON.parse(r.text)
      return [
        '【库概览】已更新',
        `path=${j.path || '40-Topics/overview.md'}`,
        j.counts ? `counts=${JSON.stringify(j.counts)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【库概览】\n${r.text.slice(0, 800)}`
    }
  }

  if (kind === 'career_status') {
    const r = await runCmd(
      'node',
      [path.join(scripts, 'career-status.mjs')],
      { timeoutMs: 20_000 },
    )
    return r.ok ? r.text : `【求职状态失败】\n${r.text.slice(0, 600)}`
  }

  if (kind === 'weekly') {
    const r = await runCmd('node', [path.join(scripts, 'weekly-review.mjs')], {
      timeoutMs: 60_000,
    })
    if (!r.ok) return `【本周复盘失败】\n${r.text}`
    try {
      const j = JSON.parse(r.text)
      return [
        '【本周复盘】骨架已生成',
        `week=${j.week || ''}`,
        `path=${j.path || j.file || j.out || ''}`.trim(),
        j.summary ? String(j.summary).slice(0, 400) : '',
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      return `【本周复盘】\n${r.text.slice(0, 1600)}`
    }
  }
  return '未知知识库命令'
}
