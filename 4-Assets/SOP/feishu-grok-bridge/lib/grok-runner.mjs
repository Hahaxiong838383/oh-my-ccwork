/**
 * Spawn grok headless with sticky session resume / mint / stop support.
 * 2026-07-21: dynamic wall budget + max-turns/timeout same-session continue
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  buildAgentRules,
  classifyMode,
  isAlreadyInUseError,
  isTimeoutError,
  isMaxTurnsError,
  isRetriableSessionError,
  resolveStickySession,
} from './grok-session.mjs'
import {
  estimateTaskBudget,
  formatBudgetMin,
} from './task-budget.mjs'

/**
 * @param {object} deps
 * @param {Function} deps.log
 * @param {{ has: Function, add: Function, delete: Function }} deps.liveTracker
 * @param {Function} deps.archiveSessionDir
 */
export function createGrokRunner(deps) {
  const log = deps.log || (() => {})
  const liveTracker = deps.liveTracker
  const archiveSessionDir = deps.archiveSessionDir

  async function runGrok(
    prompt,
    { sessionKey, chatId, cwd, mapStore, historyText, sessionRuntime, hasMedia = false },
  ) {
    const bin = process.env.GROK_BIN || `${process.env.HOME}/.grok/bin/grok`
    const { mode, maxTurns } = classifyMode(prompt, { hasMedia })
    const budget = estimateTaskBudget(prompt, { mode, hasMedia })
    const timeoutMs = budget.timeoutMs
    const budgetLabel = formatBudgetMin(timeoutMs)

    const sticky = await resolveStickySession(sessionKey, {
      chatId,
      cwd,
      mapStore,
      liveTracker,
      archiveSessionDir,
      log,
    })
    let sessionId = sticky.sessionId
    const rules = buildAgentRules({ cwd })

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
      '【系统续跑】上一轮因轮次或墙钟限制中断。请直接接着未完成工作推进，不要从零重做；完成后中文简短自检汇报（结论先行）。'

    let effectivePrompt = prompt
    if (historyText) {
      effectivePrompt = [
        '【近期对话上下文（自动注入，可参考）】',
        historyText,
        '',
        '【当前任务】',
        prompt,
      ].join('\n')
    }

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
      const extra = (process.env.GROK_EXTRA_ARGS || '').trim()
      if (extra && (mode === 'full' || process.env.GROK_EXTRA_ARGS_ALWAYS === '1')) {
        args.push(...extra.split(/\s+/).filter(Boolean))
      }
      if (
        mode === 'full' &&
        !args.includes('--experimental-memory') &&
        process.env.GROK_FORCE_MEMORY_ON_FULL !== '0'
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
      NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,.feishu.cn',
      no_proxy: process.env.NO_PROXY || 'localhost,127.0.0.1,.feishu.cn',
      CI: '1',
      GROK_HEADLESS: '1',
    }

    function once(useArgs, wallMs, trackSessionId) {
      return new Promise((resolve, reject) => {
        if (sessionRuntime?.wasStopRequested(sessionKey)) {
          reject(new Error('stopped by user'))
          return
        }
        if (trackSessionId) liveTracker?.add?.(trackSessionId)
        const child = spawn(bin, useArgs, {
          env,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (sessionRuntime && sessionKey) {
          sessionRuntime.registerChild(sessionKey, child)
        }
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
          if (trackSessionId) liveTracker?.delete?.(trackSessionId)
          const err = new Error(`grok timeout after ${wallMs}ms`)
          err.isTimeout = true
          err.partialOutput = stdout.trim()
          reject(err)
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
          if (trackSessionId) liveTracker?.delete?.(trackSessionId)
          reject(err)
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (trackSessionId) liveTracker?.delete?.(trackSessionId)
          if (sessionRuntime?.wasStopRequested(sessionKey)) {
            reject(new Error('stopped by user'))
            return
          }
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
      const next = randomUUID()
      await mapStore.setEntry(sessionKey, {
        sessionId: next,
        rotatedAt: new Date().toISOString(),
        reason,
      })
      log('session mint', next.slice(0, 8), reason)
      return next
    }

    async function resumeContinue(sid, roundsLeft, seedPartial = '') {
      let lastErr = null
      let bestPartial = String(seedPartial || '').trim()
      for (let i = 0; i < roundsLeft; i++) {
        log(
          'auto-continue',
          `round=${i + 1}/${roundsLeft}`,
          `turns=${continueTurns}`,
          `sid=${sid.slice(0, 8)}`,
          `budget=${budgetLabel}`,
        )
        const contPrompt = bestPartial
          ? `${baseContinuePrompt}\n\n【上一轮未完成输出片段（供衔接）】\n${bestPartial.slice(-2500)}`
          : baseContinuePrompt
        try {
          const out = await once(
            [...buildArgs(contPrompt, continueTurns), '-r', sid],
            timeoutMs,
            sid,
          )
          return out
            ? `${out}\n\n（已自动续跑 ${i + 1} 轮）`
            : out
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
          if (!isRetriableSessionError(err)) break
        }
      }
      if (bestPartial) {
        return (
          bestPartial.slice(0, 3500) +
          '\n\n【提示】自动续跑仍未收尾；请发「继续」接着干。'
        )
      }
      throw lastErr || new Error('auto-continue exhausted')
    }

    log(
      'grok start',
      `mode=${mode}`,
      `turns=${maxTurns}`,
      `sid=${sessionId.slice(0, 8)}`,
      `skey=${sessionKey.slice(0, 48)}`,
      sticky.exists ? `size=${sticky.size}` : 'new',
      sticky.rotated ? 'rotated' : '',
      `budget=${budgetLabel}`,
      `level=${budget.level}`,
      `score=${budget.score}`,
      `continue_rounds=${continueRounds}`,
    )

    // 1) sticky resume
    if (sticky.exists && !sticky.skipResume) {
      try {
        return await once(
          [...buildArgs(effectivePrompt, maxTurns), '-r', sessionId],
          timeoutMs,
          sessionId,
        )
      } catch (err) {
        log(
          'grok resume fail',
          sessionId.slice(0, 8),
          String(err.message || err).slice(0, 160),
        )
        // max-turns / timeout → same session continue
        if (isRetriableSessionError(err) && continueRounds > 0) {
          try {
            return await resumeContinue(
              sessionId,
              continueRounds,
              err.partialOutput || '',
            )
          } catch (contErr) {
            if (contErr?.partialOutput || err?.partialOutput) {
              return (
                String(contErr?.partialOutput || err.partialOutput).slice(
                  0,
                  3500,
                ) + '\n\n【提示】自动续跑仍未收尾；请发「继续」接着干。'
              )
            }
            throw contErr
          }
        }
        // auth hard fail → mint
        if (/not signed in|login --device/i.test(String(err.message || ''))) {
          sessionId = await mintNewSession('resume_auth_fail')
          return once(
            [...buildArgs(effectivePrompt, maxTurns), '-s', sessionId],
            timeoutMs,
            sessionId,
          )
        }
        // already in use → mint
        if (isAlreadyInUseError(err)) {
          sessionId = await mintNewSession('already_in_use')
          try {
            return await once(
              [...buildArgs(effectivePrompt, maxTurns), '-s', sessionId],
              timeoutMs,
              sessionId,
            )
          } catch (err2) {
            if (isRetriableSessionError(err2) && continueRounds > 0) {
              return resumeContinue(
                sessionId,
                continueRounds,
                err2.partialOutput || '',
              )
            }
            throw err2
          }
        }
        // other resume miss: try same id with -s once, then throw (no silent mint on max turns)
        try {
          return await once(
            [...buildArgs(effectivePrompt, maxTurns), '-s', sessionId],
            timeoutMs,
            sessionId,
          )
        } catch (err2) {
          if (isRetriableSessionError(err2) && continueRounds > 0) {
            return resumeContinue(
              sessionId,
              continueRounds,
              err2.partialOutput || '',
            )
          }
          throw err2
        }
      }
    }

    // 2) new / no-resume
    try {
      return await once(
        [...buildArgs(effectivePrompt, maxTurns), '-s', sessionId],
        timeoutMs,
        sessionId,
      )
    } catch (err2) {
      log('grok -s failed', String(err2.message || err2).slice(0, 200))
      if (isRetriableSessionError(err2) && continueRounds > 0) {
        try {
          return await resumeContinue(
            sessionId,
            continueRounds,
            err2.partialOutput || '',
          )
        } catch (contErr) {
          if (contErr?.partialOutput || err2?.partialOutput) {
            return (
              String(contErr?.partialOutput || err2.partialOutput).slice(
                0,
                3500,
              ) + '\n\n【提示】自动续跑仍未收尾；请发「继续」接着干。'
            )
          }
          throw contErr
        }
      }
      if (isAlreadyInUseError(err2)) {
        sessionId = await mintNewSession('create_already_in_use')
        try {
          return await once(
            [...buildArgs(effectivePrompt, maxTurns), '-s', sessionId],
            timeoutMs,
            sessionId,
          )
        } catch (err3) {
          log('grok -s mint fail', String(err3.message || err3).slice(0, 160))
          throw err3
        }
      }
      throw err2
    }
  }

  return { runGrok }
}
